import { K8sModel } from '@openshift-console/dynamic-plugin-sdk';

export const BareMetalHostModel: K8sModel = {
  apiVersion: 'v1alpha1',
  apiGroup: 'metal3.io',
  kind: 'BareMetalHost',
  abbr: 'BMH',
  label: 'BareMetalHost',
  labelPlural: 'BareMetalHosts',
  plural: 'baremetalhosts',
  namespaced: true,
};

export const DataSourceModel: K8sModel = {
  apiVersion: 'v1beta1',
  apiGroup: 'cdi.kubevirt.io',
  kind: 'DataSource',
  abbr: 'DS',
  label: 'DataSource',
  labelPlural: 'DataSources',
  plural: 'datasources',
  namespaced: true,
};

export const DataImportCronModel: K8sModel = {
  apiVersion: 'v1beta1',
  apiGroup: 'cdi.kubevirt.io',
  kind: 'DataImportCron',
  abbr: 'DIC',
  label: 'DataImportCron',
  labelPlural: 'DataImportCrons',
  plural: 'dataimportcrons',
  namespaced: true,
};

export const SecretModel: K8sModel = {
  apiVersion: 'v1',
  apiGroup: 'core',
  kind: 'Secret',
  abbr: 'S',
  label: 'Secret',
  labelPlural: 'Secrets',
  plural: 'secrets',
  namespaced: true,
};

export const NodeModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'Node',
  abbr: 'N',
  label: 'Node',
  labelPlural: 'Nodes',
  plural: 'nodes',
  namespaced: false,
};

/** Cluster-scoped NMState report of a node's live interfaces. */
export const NodeNetworkStateModel: K8sModel = {
  apiVersion: 'v1beta1',
  apiGroup: 'nmstate.io',
  kind: 'NodeNetworkState',
  abbr: 'NNS',
  label: 'NodeNetworkState',
  labelPlural: 'NodeNetworkStates',
  plural: 'nodenetworkstates',
  namespaced: false,
};

/** Cluster-scoped NMState desired-state policy. Network Bond creates these. */
export const NodeNetworkConfigurationPolicyModel: K8sModel = {
  apiVersion: 'v1',
  apiGroup: 'nmstate.io',
  kind: 'NodeNetworkConfigurationPolicy',
  abbr: 'NNCP',
  label: 'NodeNetworkConfigurationPolicy',
  labelPlural: 'NodeNetworkConfigurationPolicies',
  plural: 'nodenetworkconfigurationpolicies',
  namespaced: false,
};

/** Cluster-scoped Metal3 Provisioning CR (`provisioning-configuration`). */
export const ProvisioningModel: K8sModel = {
  apiVersion: 'v1alpha1',
  apiGroup: 'metal3.io',
  kind: 'Provisioning',
  abbr: 'P',
  label: 'Provisioning',
  labelPlural: 'Provisionings',
  plural: 'provisionings',
  namespaced: false,
};

export const MACHINE_API_NS = 'openshift-machine-api';

export type ProvisioningKind = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string };
  spec?: {
    watchAllNamespaces?: boolean;
  };
};

export function isWatchAllNamespacesEnabled(
  provisioning?: ProvisioningKind | null,
): boolean {
  return provisioning?.spec?.watchAllNamespaces === true;
}

function isNotFoundError(err: unknown): boolean {
  if (!err) return false;
  const status =
    (err as { status?: number }).status ||
    (err as { response?: { status?: number } }).response?.status ||
    (err as { json?: { code?: number } }).json?.code;
  if (status === 404) return true;
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : (err as { message?: string }).message || String(err);
  return /not found/i.test(msg);
}

/** Inventory warning: BMO is not watching all namespaces and some BMHs are outside machine-api. */
export function shouldWarnBmoNamespaceWatch(args: {
  loaded: boolean;
  error?: unknown;
  provisioning?: ProvisioningKind | null;
  hosts: Array<{ metadata: { namespace: string } }>;
}): boolean {
  if (!args.loaded) return false;
  if (args.error && !isNotFoundError(args.error)) return false;
  if (isWatchAllNamespacesEnabled(args.provisioning)) return false;
  return args.hosts.some(
    (h) => h.metadata.namespace && h.metadata.namespace !== MACHINE_API_NS,
  );
}

/** Cluster-scoped Machine Config Operator pool. Network Bond groups nodes by MCP. */
export const MachineConfigPoolModel: K8sModel = {
  apiVersion: 'v1',
  apiGroup: 'machineconfiguration.openshift.io',
  kind: 'MachineConfigPool',
  abbr: 'MCP',
  label: 'MachineConfigPool',
  labelPlural: 'MachineConfigPools',
  plural: 'machineconfigpools',
  namespaced: false,
};

export const VIRTUALIZATION_OS_IMAGES_NS = 'openshift-virtualization-os-images';

export type BareMetalHostSpec = {
  automatedCleaningMode?: string;
  bmc?: {
    address: string;
    credentialsName: string;
    disableCertificateVerification?: boolean;
  };
  bootMACAddress?: string;
  online?: boolean;
  rootDeviceHints?: {
    deviceName?: string;
    serialNumber?: string;
    wwn?: string;
    vendor?: string;
    model?: string;
    minSizeGigabytes?: number;
    rotational?: boolean;
  };
  image?: {
    url: string;
    checksum: string;
    checksumType?: string;
  };
  userData?: {
    name: string;
    namespace: string;
  };
  networkData?: {
    name: string;
    namespace: string;
  };
  preprovisioningNetworkDataName?: string;
  consumerRef?: {
    apiVersion?: string;
    kind?: string;
    name?: string;
    namespace?: string;
  };
};

export type BareMetalHostStatus = {
  errorCount?: number;
  errorMessage?: string;
  errorType?: string;
  hardwareProfile?: string;
  operationalStatus?: string;
  poweredOn?: boolean;
  lastUpdated?: string;
  provisioning?: {
    ID?: string;
    bootMode?: string;
    state?: string;
    image?: {
      url?: string;
      checksum?: string;
      checksumType?: string;
    };
  };
  hardware?: {
    cpu?: {
      arch?: string;
      count?: number;
      model?: string;
      clockMegahertz?: number;
    };
    ramMebibytes?: number;
    nics?: Array<{
      name: string;
      mac: string;
      ip?: string;
      speedGbps?: number;
      model?: string;
    }>;
    storage?: Array<{
      name: string;
      sizeBytes: number;
      type?: string;
      model?: string;
      vendor?: string;
    }>;
    systemVendor?: {
      manufacturer?: string;
      productName?: string;
      serialNumber?: string;
    };
  };
};

export type BareMetalHostKind = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    uid?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: BareMetalHostSpec;
  status?: BareMetalHostStatus;
};

export type DataSourceKind = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    source?: {
      pvc?: {
        name: string;
        namespace: string;
      };
    };
  };
  status?: {
    conditions?: Array<{
      type: string;
      status: string;
      message?: string;
    }>;
    source?: {
      pvc?: {
        name: string;
        namespace: string;
      };
    };
  };
};

export type DataImportCronKind = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    template?: {
      spec?: {
        source?: {
          registry?: {
            url?: string;
            imageStream?: string;
            pullMethod?: string;
          };
          http?: {
            url?: string;
          };
        };
      };
    };
    managedDataSource?: string;
  };
};

export function getProvisioningState(bmh: BareMetalHostKind): string {
  return bmh.status?.provisioning?.state || 'unknown';
}

export function isPoweredOn(bmh: BareMetalHostKind): boolean {
  return bmh.status?.poweredOn ?? false;
}

export function getHardwareSummary(bmh: BareMetalHostKind): string {
  const hw = bmh.status?.hardware;
  if (!hw) return '—';

  const parts: string[] = [];

  if (hw.cpu) {
    parts.push(`${hw.cpu.count} cores ${hw.cpu.arch || ''}`);
    if (hw.cpu.model) parts.push(hw.cpu.model);
  }

  if (hw.ramMebibytes) {
    const gb = Math.round(hw.ramMebibytes / 1024);
    parts.push(`${gb} GB RAM`);
  }

  if (hw.storage?.length) {
    const totalTB = hw.storage.reduce((acc, d) => acc + d.sizeBytes, 0) / 1e12;
    parts.push(`${totalTB.toFixed(1)} TB storage`);
  }

  return parts.join(' · ') || '—';
}

export function getSystemVendorInfo(bmh: BareMetalHostKind): string {
  const sv = bmh.status?.hardware?.systemVendor;
  if (!sv) return '—';
  return [sv.manufacturer, sv.productName].filter(Boolean).join(' ');
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function isAvailableForProvisioning(bmh: BareMetalHostKind): boolean {
  const state = getProvisioningState(bmh);
  return state === 'available' || state === 'ready';
}

export function isProvisioned(bmh: BareMetalHostKind): boolean {
  return getProvisioningState(bmh) === 'provisioned';
}

export type NodeKind = {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    uid?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  status?: {
    addresses?: Array<{
      type?: string;
      address?: string;
    }>;
  };
};

export type NodeNetworkStateKind = {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    uid?: string;
  };
  status?: {
    currentState?: unknown;
  };
};
