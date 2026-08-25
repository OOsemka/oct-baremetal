/**
 * Resolves the host IP that carries the default route (0.0.0.0/0 or ::/0).
 * Live NodeNetworkState is preferred; provisioned BMH networkData NMState is
 * the equivalent for standalone Metal3 hosts that are not cluster nodes.
 */
import * as yaml from 'js-yaml';
import {
  BareMetalHostKind,
  NodeKind,
  NodeNetworkStateKind,
  isProvisioned,
} from './k8s-resources';

export type RoutableIpSource = 'nmstate' | 'network-data' | 'node-internal-ip';

export type RoutableIp = {
  ip: string;
  interface?: string;
  source: RoutableIpSource;
};

type NmstateAddress = {
  ip?: string;
  'prefix-length'?: number;
};

type NmstateInterface = {
  name?: string;
  type?: string;
  ipv4?: {
    enabled?: boolean;
    address?: NmstateAddress[];
  };
  ipv6?: {
    enabled?: boolean;
    address?: NmstateAddress[];
  };
};

type NmstateRoute = {
  destination?: string;
  'next-hop-interface'?: string;
  'next-hop-address'?: string;
  metric?: number;
  'table-id'?: number;
  state?: string;
};

export type NmstateNetworkState = {
  interfaces?: NmstateInterface[];
  routes?: {
    config?: NmstateRoute[] | null;
    running?: NmstateRoute[] | null;
  };
};

const MACHINE_ANNOTATION = 'machine.openshift.io/machine';

function isIpv4Default(destination: string): boolean {
  return destination === '0.0.0.0/0' || destination === 'default';
}

function isIpv6Default(destination: string): boolean {
  return destination === '::/0';
}

function isUnusableIpv4(ip: string): boolean {
  return (
    ip.startsWith('127.') ||
    ip.startsWith('169.254.') ||
    ip === '0.0.0.0'
  );
}

function isUnusableIpv6(ip: string): boolean {
  const n = ip.toLowerCase();
  return n === '::1' || n === '::' || n.startsWith('fe80:');
}

function asRouteList(value: NmstateRoute[] | null | undefined): NmstateRoute[] {
  return Array.isArray(value) ? value : [];
}

function sortByMetric(routes: NmstateRoute[]): NmstateRoute[] {
  return [...routes].sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0));
}

function pickInterfaceAddress(iface: NmstateInterface, wantIpv4: boolean): string | null {
  if (wantIpv4) {
    const addrs = iface.ipv4?.address || [];
    for (const addr of addrs) {
      if (addr.ip && !isUnusableIpv4(addr.ip)) {
        return addr.ip;
      }
    }
    return null;
  }
  const addrs = iface.ipv6?.address || [];
  for (const addr of addrs) {
    if (addr.ip && !isUnusableIpv6(addr.ip)) {
      return addr.ip;
    }
  }
  return null;
}

function pickFromNamedInterfaces(
  interfaces: NmstateInterface[],
  name: string,
  wantIpv4: boolean,
): { ip: string; iface: NmstateInterface } | null {
  const matches = interfaces.filter((i) => i.name === name);
  for (const iface of matches) {
    const ip = pickInterfaceAddress(iface, wantIpv4);
    if (ip) {
      return { ip, iface };
    }
  }
  return null;
}

function ipFromDefaultRoutes(
  routes: NmstateRoute[],
  interfaces: NmstateInterface[],
): Omit<RoutableIp, 'source'> | null {
  const v4 = sortByMetric(
    routes.filter(
      (r) =>
        r.state !== 'ignore' &&
        isIpv4Default(r.destination || '') &&
        r['next-hop-interface'],
    ),
  );
  const v6 = sortByMetric(
    routes.filter(
      (r) =>
        r.state !== 'ignore' &&
        isIpv6Default(r.destination || '') &&
        r['next-hop-interface'],
    ),
  );

  for (const route of v4) {
    const picked = pickFromNamedInterfaces(interfaces, route['next-hop-interface'] as string, true);
    if (picked) {
      return { ip: picked.ip, interface: picked.iface.name };
    }
  }

  for (const route of v6) {
    const picked = pickFromNamedInterfaces(interfaces, route['next-hop-interface'] as string, false);
    if (picked) {
      return { ip: picked.ip, interface: picked.iface.name };
    }
  }

  return null;
}

export function parseNmstateNetworkState(raw: unknown): NmstateNetworkState | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed as NmstateNetworkState;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') {
    return raw as NmstateNetworkState;
  }
  return null;
}

/** IP on the default-route interface. Prefers IPv4; prefers running over config. */
export function routableIpFromNmstate(raw: unknown): Omit<RoutableIp, 'source'> | null {
  const state = parseNmstateNetworkState(raw);
  if (!state) return null;
  const interfaces = Array.isArray(state.interfaces) ? state.interfaces : [];
  const running = asRouteList(state.routes?.running);
  const config = asRouteList(state.routes?.config);
  return ipFromDefaultRoutes(running, interfaces) || ipFromDefaultRoutes(config, interfaces);
}

export function networkDataRefKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

export function decodeNmstateSecretData(data: Record<string, string> | undefined): string | null {
  if (!data) return null;
  const encoded = data.nmstate || data.networkData;
  if (!encoded) return null;
  try {
    return atob(encoded);
  } catch {
    return null;
  }
}

export function findNodeForBmh(bmh: BareMetalHostKind, nodes: NodeKind[]): NodeKind | undefined {
  const byName = nodes.find((n) => n.metadata.name === bmh.metadata.name);
  if (byName) return byName;

  const consumer = bmh.spec.consumerRef;
  if (!consumer?.name) return undefined;
  const expected = consumer.namespace
    ? `${consumer.namespace}/${consumer.name}`
    : undefined;
  return nodes.find((n) => {
    const machine = n.metadata.annotations?.[MACHINE_ANNOTATION];
    if (!machine) return false;
    if (expected && machine === expected) return true;
    return machine.endsWith(`/${consumer.name}`);
  });
}

export function findNnsForBmh(
  bmh: BareMetalHostKind,
  nnsList: NodeNetworkStateKind[],
  node?: NodeKind,
): NodeNetworkStateKind | undefined {
  const byBmhName = nnsList.find((nns) => nns.metadata.name === bmh.metadata.name);
  if (byBmhName) return byBmhName;
  if (node) {
    return nnsList.find((nns) => nns.metadata.name === node.metadata.name);
  }
  return undefined;
}

function nodeInternalIp(node: NodeKind | undefined): string | null {
  const addrs = node?.status?.addresses || [];
  const internal = addrs.find((a) => a.type === 'InternalIP' && a.address);
  if (!internal?.address) return null;
  if (internal.address.includes(':')) {
    return isUnusableIpv6(internal.address) ? null : internal.address;
  }
  return isUnusableIpv4(internal.address) ? null : internal.address;
}

export function resolveBareMetalHostRoutableIp(args: {
  bmh: BareMetalHostKind;
  nnsList: NodeNetworkStateKind[];
  nodes: NodeKind[];
  networkDataByRef: Record<string, string | null>;
  nnsLoaded?: boolean;
}): RoutableIp | null {
  const { bmh, nnsList, nodes, networkDataByRef, nnsLoaded = true } = args;
  const node = findNodeForBmh(bmh, nodes);
  const nns = findNnsForBmh(bmh, nnsList, node);

  if (nns) {
    const live = routableIpFromNmstate(nns.status?.currentState);
    if (live) {
      return { ...live, source: 'nmstate' };
    }
    // NNS exists but has no default-route IP — do not guess InternalIP.
    return null;
  }

  const nd = bmh.spec.networkData;
  if (isProvisioned(bmh) && nd?.name) {
    const key = networkDataRefKey(nd.namespace || bmh.metadata.namespace, nd.name);
    const yamlText = networkDataByRef[key];
    if (yamlText) {
      const fromSecret = routableIpFromNmstate(yamlText);
      if (fromSecret) {
        return { ...fromSecret, source: 'network-data' };
      }
    }
  }

  if (!nnsLoaded) {
    return null;
  }

  const fallback = nodeInternalIp(node);
  if (fallback) {
    return { ip: fallback, source: 'node-internal-ip' };
  }

  return null;
}
