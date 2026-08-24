/**
 * Converts nmstate YAML network configuration into NetworkManager keyfile
 * (.nmconnection) format. This avoids the need for nmstatectl which is not
 * present on base RHEL9 images. NetworkManager reads keyfiles natively on boot.
 *
 * Supported topologies: bonds, bridges, VLANs, standalone ethernet,
 * static/DHCP IPv4, static/SLAAC/DHCPv6/disabled IPv6, DNS, static routes.
 */
import * as yaml from 'js-yaml';

interface NmstateAddress {
  ip: string;
  'prefix-length': number;
}

interface NmstateIpv4 {
  enabled: boolean;
  dhcp?: boolean;
  address?: NmstateAddress[];
}

interface NmstateIpv6 {
  enabled: boolean;
  dhcp?: boolean;
  autoconf?: boolean;
  address?: NmstateAddress[];
}

interface NmstateLinkAggregation {
  mode: string;
  options?: Record<string, string | number>;
  port: string[];
}

interface NmstateVlan {
  'base-iface': string;
  id: number;
}

interface NmstateBridgePort {
  name: string;
  'stp-hairpin-mode'?: boolean;
  'stp-path-cost'?: number;
  'stp-priority'?: number;
}

interface NmstateBridge {
  port?: NmstateBridgePort[];
  options?: {
    stp?: { enabled?: boolean };
    'group-forward-mask'?: number;
    'mac-ageing-time'?: number;
    'multicast-snooping'?: boolean;
  };
}

interface NmstateInterface {
  name: string;
  type: string;
  state?: string;
  ipv4?: NmstateIpv4;
  ipv6?: NmstateIpv6;
  'link-aggregation'?: NmstateLinkAggregation;
  'mac-address'?: string;
  identifier?: string;
  vlan?: NmstateVlan;
  bridge?: NmstateBridge;
}

interface NmstateRoute {
  destination: string;
  'next-hop-address': string;
  'next-hop-interface': string;
  'table-id'?: number;
  metric?: number;
}

interface NmstateConfig {
  interfaces?: NmstateInterface[];
  routes?: {
    config?: NmstateRoute[];
  };
  'dns-resolver'?: {
    config?: {
      server?: string[];
      search?: string[];
    };
  };
}

export interface KeyfileOutput {
  filename: string;
  content: string;
}

const AUTOCONNECT_PRIORITY = '999';

function isIpv6Route(route: NmstateRoute): boolean {
  return route.destination.includes(':');
}

function buildIniSection(name: string, entries: [string, string][]): string {
  if (entries.length === 0) return '';
  const lines = [`[${name}]`];
  for (const [key, value] of entries) {
    lines.push(`${key}=${value}`);
  }
  return lines.join('\n');
}

function buildKeyfile(sections: { name: string; entries: [string, string][] }[]): string {
  return sections
    .filter((s) => s.entries.length > 0)
    .map((s) => buildIniSection(s.name, s.entries))
    .join('\n\n')
    + '\n';
}

function findDefaultGateway(
  routes: NmstateRoute[],
  ifaceName: string,
  ipv6 = false,
): string | undefined {
  const defaultDest = ipv6 ? '::/0' : '0.0.0.0/0';
  const defaultRoute = routes.find(
    (r) =>
      r['next-hop-interface'] === ifaceName &&
      (r.destination === defaultDest || (!ipv6 && r.destination === 'default')),
  );
  return defaultRoute?.['next-hop-address'];
}

/**
 * DNS goes only on interfaces that carry a default route.
 * Falls back to the first interface with a static IPv4 address.
 */
function findDnsTargetInterfaces(
  interfaces: NmstateInterface[],
  routes: NmstateRoute[],
): Set<string> {
  const targets = new Set<string>();

  for (const route of routes) {
    if (
      route.destination === '0.0.0.0/0' ||
      route.destination === 'default' ||
      route.destination === '::/0'
    ) {
      targets.add(route['next-hop-interface']);
    }
  }

  if (targets.size === 0) {
    for (const iface of interfaces) {
      if (iface.ipv4?.enabled && iface.ipv4.address?.length) {
        targets.add(iface.name);
        break;
      }
    }
  }

  return targets;
}

function buildIpv4Section(
  iface: NmstateInterface,
  routes: NmstateRoute[],
  dnsServers: string[],
  dnsSearch: string[],
  isDnsTarget: boolean,
): [string, string][] {
  const entries: [string, string][] = [];

  if (!iface.ipv4?.enabled) {
    entries.push(['method', 'disabled']);
    return entries;
  }

  if (iface.ipv4.dhcp) {
    entries.push(['method', 'auto']);
  } else {
    entries.push(['method', 'manual']);

    const addresses = iface.ipv4.address || [];
    const gateway = findDefaultGateway(routes, iface.name, false);

    addresses.forEach((addr, idx) => {
      const addrStr = `${addr.ip}/${addr['prefix-length']}`;
      const key = `address${idx + 1}`;
      if (idx === 0 && gateway) {
        entries.push([key, `${addrStr},${gateway}`]);
      } else {
        entries.push([key, addrStr]);
      }
    });

    const staticRoutes = routes.filter(
      (r) =>
        !isIpv6Route(r) &&
        r['next-hop-interface'] === iface.name &&
        r.destination !== '0.0.0.0/0' &&
        r.destination !== 'default',
    );
    staticRoutes.forEach((route, idx) => {
      let routeStr = `${route.destination},${route['next-hop-address']}`;
      if (route.metric !== undefined) {
        routeStr += `,${route.metric}`;
      }
      entries.push([`route${idx + 1}`, routeStr]);
    });
  }

  if (isDnsTarget) {
    const ipv4Dns = dnsServers.filter((s) => !s.includes(':'));
    if (ipv4Dns.length > 0) {
      entries.push(['dns', ipv4Dns.join(';') + ';']);
    }
    if (dnsSearch.length > 0) {
      entries.push(['dns-search', dnsSearch.join(';') + ';']);
    }
  }

  return entries;
}

function buildIpv6Section(
  iface: NmstateInterface,
  routes: NmstateRoute[],
  dnsServers: string[],
  dnsSearch: string[],
  isDnsTarget: boolean,
): [string, string][] {
  const entries: [string, string][] = [];

  if (!iface.ipv6?.enabled) {
    entries.push(['method', 'disabled']);
    return entries;
  }

  const hasStaticAddrs = (iface.ipv6.address?.length ?? 0) > 0;

  if (hasStaticAddrs) {
    entries.push(['method', 'manual']);

    const gateway = findDefaultGateway(routes, iface.name, true);
    iface.ipv6.address!.forEach((addr, idx) => {
      const addrStr = `${addr.ip}/${addr['prefix-length']}`;
      const key = `address${idx + 1}`;
      if (idx === 0 && gateway) {
        entries.push([key, `${addrStr},${gateway}`]);
      } else {
        entries.push([key, addrStr]);
      }
    });

    const staticRoutes = routes.filter(
      (r) =>
        isIpv6Route(r) &&
        r['next-hop-interface'] === iface.name &&
        r.destination !== '::/0',
    );
    staticRoutes.forEach((route, idx) => {
      let routeStr = `${route.destination},${route['next-hop-address']}`;
      if (route.metric !== undefined) {
        routeStr += `,${route.metric}`;
      }
      entries.push([`route${idx + 1}`, routeStr]);
    });
  } else if (iface.ipv6.dhcp || iface.ipv6.autoconf) {
    entries.push(['method', 'auto']);
  } else {
    entries.push(['method', 'link-local']);
  }

  if (isDnsTarget) {
    const ipv6Dns = dnsServers.filter((s) => s.includes(':'));
    if (ipv6Dns.length > 0) {
      entries.push(['dns', ipv6Dns.join(';') + ';']);
    }
    if (dnsSearch.length > 0 && hasStaticAddrs) {
      entries.push(['dns-search', dnsSearch.join(';') + ';']);
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Keyfile generators per interface type
// ---------------------------------------------------------------------------

function generateBondKeyfile(
  iface: NmstateInterface,
  routes: NmstateRoute[],
  dnsServers: string[],
  dnsSearch: string[],
  isDnsTarget: boolean,
): KeyfileOutput {
  const agg = iface['link-aggregation']!;

  const connectionEntries: [string, string][] = [
    ['id', iface.name],
    ['type', 'bond'],
    ['interface-name', iface.name],
    ['autoconnect', 'true'],
    ['autoconnect-priority', AUTOCONNECT_PRIORITY],
  ];

  const bondEntries: [string, string][] = [['mode', agg.mode]];
  if (agg.options) {
    for (const [key, value] of Object.entries(agg.options)) {
      bondEntries.push([key.replace(/-/g, '_'), String(value)]);
    }
  }

  const ipv4Entries = buildIpv4Section(iface, routes, dnsServers, dnsSearch, isDnsTarget);
  const ipv6Entries = buildIpv6Section(iface, routes, dnsServers, dnsSearch, isDnsTarget);

  return {
    filename: `${iface.name}.nmconnection`,
    content: buildKeyfile([
      { name: 'connection', entries: connectionEntries },
      { name: 'bond', entries: bondEntries },
      { name: 'ipv4', entries: ipv4Entries },
      { name: 'ipv6', entries: ipv6Entries },
    ]),
  };
}

function generateBondSlaveKeyfile(
  slaveName: string,
  masterName: string,
  macAddress: string | undefined,
): KeyfileOutput {
  const connId = `${masterName}-slave-${slaveName}`;

  const connectionEntries: [string, string][] = [
    ['id', connId],
    ['type', 'ethernet'],
    ['master', masterName],
    ['slave-type', 'bond'],
    ['autoconnect', 'true'],
    ['autoconnect-priority', AUTOCONNECT_PRIORITY],
  ];

  const ethernetEntries: [string, string][] = [];
  if (macAddress) {
    ethernetEntries.push(['mac-address', macAddress.toUpperCase()]);
  }

  return {
    filename: `${connId}.nmconnection`,
    content: buildKeyfile([
      { name: 'connection', entries: connectionEntries },
      { name: 'ethernet', entries: ethernetEntries },
    ]),
  };
}

function generateBridgeKeyfile(
  iface: NmstateInterface,
  routes: NmstateRoute[],
  dnsServers: string[],
  dnsSearch: string[],
  isDnsTarget: boolean,
): KeyfileOutput {
  const bridge = iface.bridge!;

  const connectionEntries: [string, string][] = [
    ['id', iface.name],
    ['type', 'bridge'],
    ['interface-name', iface.name],
    ['autoconnect', 'true'],
    ['autoconnect-priority', AUTOCONNECT_PRIORITY],
  ];

  const bridgeEntries: [string, string][] = [];
  if (bridge.options?.stp?.enabled !== undefined) {
    bridgeEntries.push(['stp', bridge.options.stp.enabled ? 'true' : 'false']);
  }
  if (bridge.options?.['group-forward-mask'] !== undefined) {
    bridgeEntries.push(['group-forward-mask', String(bridge.options['group-forward-mask'])]);
  }
  if (bridge.options?.['mac-ageing-time'] !== undefined) {
    bridgeEntries.push(['ageing-time', String(bridge.options['mac-ageing-time'])]);
  }
  if (bridge.options?.['multicast-snooping'] !== undefined) {
    bridgeEntries.push([
      'multicast-snooping',
      bridge.options['multicast-snooping'] ? 'true' : 'false',
    ]);
  }

  const ipv4Entries = buildIpv4Section(iface, routes, dnsServers, dnsSearch, isDnsTarget);
  const ipv6Entries = buildIpv6Section(iface, routes, dnsServers, dnsSearch, isDnsTarget);

  return {
    filename: `${iface.name}.nmconnection`,
    content: buildKeyfile([
      { name: 'connection', entries: connectionEntries },
      { name: 'bridge', entries: bridgeEntries },
      { name: 'ipv4', entries: ipv4Entries },
      { name: 'ipv6', entries: ipv6Entries },
    ]),
  };
}

function generateBridgePortKeyfile(
  portName: string,
  masterName: string,
  macAddress: string | undefined,
): KeyfileOutput {
  const connId = `${masterName}-port-${portName}`;

  const connectionEntries: [string, string][] = [
    ['id', connId],
    ['type', 'ethernet'],
    ['master', masterName],
    ['slave-type', 'bridge'],
    ['autoconnect', 'true'],
    ['autoconnect-priority', AUTOCONNECT_PRIORITY],
  ];

  const ethernetEntries: [string, string][] = [];
  if (macAddress) {
    ethernetEntries.push(['mac-address', macAddress.toUpperCase()]);
  }

  return {
    filename: `${connId}.nmconnection`,
    content: buildKeyfile([
      { name: 'connection', entries: connectionEntries },
      { name: 'ethernet', entries: ethernetEntries },
    ]),
  };
}

function generateEthernetKeyfile(
  iface: NmstateInterface,
  routes: NmstateRoute[],
  dnsServers: string[],
  dnsSearch: string[],
  isDnsTarget: boolean,
): KeyfileOutput {
  const connectionEntries: [string, string][] = [
    ['id', iface.name],
    ['type', 'ethernet'],
    ['interface-name', iface.name],
    ['autoconnect', 'true'],
    ['autoconnect-priority', AUTOCONNECT_PRIORITY],
  ];

  const ethernetEntries: [string, string][] = [];
  if (iface['mac-address']) {
    ethernetEntries.push(['mac-address', iface['mac-address'].toUpperCase()]);
  }

  const ipv4Entries = buildIpv4Section(iface, routes, dnsServers, dnsSearch, isDnsTarget);
  const ipv6Entries = buildIpv6Section(iface, routes, dnsServers, dnsSearch, isDnsTarget);

  return {
    filename: `${iface.name}.nmconnection`,
    content: buildKeyfile([
      { name: 'connection', entries: connectionEntries },
      { name: 'ethernet', entries: ethernetEntries },
      { name: 'ipv4', entries: ipv4Entries },
      { name: 'ipv6', entries: ipv6Entries },
    ]),
  };
}

function generateVlanKeyfile(
  iface: NmstateInterface,
  routes: NmstateRoute[],
  dnsServers: string[],
  dnsSearch: string[],
  isDnsTarget: boolean,
): KeyfileOutput {
  const vlan = iface.vlan!;
  const vlanIfName = iface.name.includes('.')
    ? iface.name
    : `${vlan['base-iface']}.${vlan.id}`;

  const connectionEntries: [string, string][] = [
    ['id', iface.name],
    ['type', 'vlan'],
    ['interface-name', vlanIfName],
    ['autoconnect', 'true'],
    ['autoconnect-priority', AUTOCONNECT_PRIORITY],
  ];

  const vlanEntries: [string, string][] = [
    ['parent', vlan['base-iface']],
    ['id', String(vlan.id)],
  ];

  const ipv4Entries = buildIpv4Section(iface, routes, dnsServers, dnsSearch, isDnsTarget);
  const ipv6Entries = buildIpv6Section(iface, routes, dnsServers, dnsSearch, isDnsTarget);

  return {
    filename: `${iface.name}.nmconnection`,
    content: buildKeyfile([
      { name: 'connection', entries: connectionEntries },
      { name: 'vlan', entries: vlanEntries },
      { name: 'ipv4', entries: ipv4Entries },
      { name: 'ipv6', entries: ipv6Entries },
    ]),
  };
}

/**
 * Minimal ethernet keyfile for a VLAN parent that has no explicit IP config.
 * The parent must exist for NM to bring up the VLAN child.
 */
function generateParentEthernetKeyfile(
  ifaceName: string,
  macAddress: string | undefined,
): KeyfileOutput {
  const connectionEntries: [string, string][] = [
    ['id', ifaceName],
    ['type', 'ethernet'],
    ['interface-name', ifaceName],
    ['autoconnect', 'true'],
    ['autoconnect-priority', AUTOCONNECT_PRIORITY],
  ];

  const ethernetEntries: [string, string][] = [];
  if (macAddress) {
    ethernetEntries.push(['mac-address', macAddress.toUpperCase()]);
  }

  return {
    filename: `${ifaceName}.nmconnection`,
    content: buildKeyfile([
      { name: 'connection', entries: connectionEntries },
      { name: 'ethernet', entries: ethernetEntries },
      { name: 'ipv4', entries: [['method', 'disabled']] },
      { name: 'ipv6', entries: [['method', 'disabled']] },
    ]),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses nmstate YAML and generates NetworkManager keyfile (.nmconnection)
 * content for each interface.
 *
 * Returns an array of { filename, content } objects. The caller can extract
 * filenames with `keyfiles.map(kf => kf.filename)` for use in cleanup scripts.
 *
 * All generated keyfiles include `autoconnect-priority=999` so they always
 * win over auto-created "Wired connection N" profiles.
 *
 * Handles: bonds, bond slaves, linux bridges, bridge ports, standalone
 * ethernet, VLANs (with auto-generated parent), static/DHCP IPv4,
 * static/SLAAC/DHCPv6/disabled IPv6, DNS, static routes.
 */
export function nmstateToKeyfiles(nmstateYaml: string): KeyfileOutput[] {
  let config: NmstateConfig;
  try {
    config = yaml.load(nmstateYaml) as NmstateConfig;
  } catch {
    return [];
  }

  if (!config || !config.interfaces) return [];

  const interfaces = config.interfaces;
  const routes = config.routes?.config || [];
  const dnsServers = config['dns-resolver']?.config?.server || [];
  const dnsSearch = config['dns-resolver']?.config?.search || [];

  const dnsTargets = findDnsTargetInterfaces(interfaces, routes);

  const keyfiles: KeyfileOutput[] = [];
  const generatedInterfaces = new Set<string>();

  const ifaceByName = new Map<string, NmstateInterface>();
  for (const iface of interfaces) {
    ifaceByName.set(iface.name, iface);
  }

  const subordinateInterfaces = new Set<string>();

  // --- Bonds ---
  for (const iface of interfaces) {
    if (iface.type === 'bond' && iface['link-aggregation']) {
      const isDns = dnsTargets.has(iface.name);
      keyfiles.push(generateBondKeyfile(iface, routes, dnsServers, dnsSearch, isDns));
      generatedInterfaces.add(iface.name);

      for (const portName of iface['link-aggregation'].port) {
        subordinateInterfaces.add(portName);
        const portIface = ifaceByName.get(portName);
        const macAddress = portIface?.['mac-address'];
        keyfiles.push(generateBondSlaveKeyfile(portName, iface.name, macAddress));
        generatedInterfaces.add(portName);
      }
    }
  }

  // --- Bridges ---
  for (const iface of interfaces) {
    if (iface.type === 'linux-bridge' && iface.bridge) {
      const isDns = dnsTargets.has(iface.name);
      keyfiles.push(generateBridgeKeyfile(iface, routes, dnsServers, dnsSearch, isDns));
      generatedInterfaces.add(iface.name);

      for (const port of iface.bridge.port || []) {
        subordinateInterfaces.add(port.name);
        if (!generatedInterfaces.has(port.name)) {
          const portIface = ifaceByName.get(port.name);
          const macAddress = portIface?.['mac-address'];
          keyfiles.push(generateBridgePortKeyfile(port.name, iface.name, macAddress));
          generatedInterfaces.add(port.name);
        }
      }
    }
  }

  // --- VLANs ---
  const vlanParents = new Set<string>();
  for (const iface of interfaces) {
    if (iface.type === 'vlan' && iface.vlan) {
      const isDns = dnsTargets.has(iface.name);
      keyfiles.push(generateVlanKeyfile(iface, routes, dnsServers, dnsSearch, isDns));
      generatedInterfaces.add(iface.name);
      vlanParents.add(iface.vlan['base-iface']);
    }
  }

  // --- Standalone ethernet (not a bond/bridge port, not already generated) ---
  for (const iface of interfaces) {
    if (
      iface.type === 'ethernet' &&
      !subordinateInterfaces.has(iface.name) &&
      !generatedInterfaces.has(iface.name)
    ) {
      if (iface.ipv4?.enabled || iface.ipv6?.enabled) {
        const isDns = dnsTargets.has(iface.name);
        keyfiles.push(generateEthernetKeyfile(iface, routes, dnsServers, dnsSearch, isDns));
        generatedInterfaces.add(iface.name);
      }
    }
  }

  // --- VLAN parent interfaces that weren't generated yet ---
  for (const parentName of vlanParents) {
    if (!generatedInterfaces.has(parentName)) {
      const parentIface = ifaceByName.get(parentName);
      const macAddress = parentIface?.['mac-address'];
      keyfiles.push(generateParentEthernetKeyfile(parentName, macAddress));
      generatedInterfaces.add(parentName);
    }
  }

  return keyfiles;
}
