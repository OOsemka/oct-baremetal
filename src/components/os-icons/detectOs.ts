export type OsFamily =
  | 'rhel'
  | 'fedora'
  | 'centos'
  | 'windows'
  | 'ubuntu'
  | 'debian'
  | 'oracle'
  | 'linux';

const PREFERENCE_LABELS = [
  'instancetype.kubevirt.io/default-preference',
  'instancetype.kubevirt.io/preference',
  'kubevirt.io/os',
  'os.template.kubevirt.io/name',
];

type DetectableSource = {
  metadata: {
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
};

function matchOs(text: string): OsFamily | undefined {
  const s = text.toLowerCase();
  if (!s.trim()) {
    return undefined;
  }

  if (
    s.includes('windows') ||
    s.includes('win2k') ||
    s.includes('win10') ||
    s.includes('win11') ||
    s.includes('microsoft') ||
    /(^|[^a-z])win(\d|_|-|$)/.test(s)
  ) {
    return 'windows';
  }
  if (s.includes('ubuntu')) {
    return 'ubuntu';
  }
  if (s.includes('debian')) {
    return 'debian';
  }
  if (s.includes('centos')) {
    return 'centos';
  }
  if (s.includes('fedora')) {
    return 'fedora';
  }
  if (
    s.includes('rhel') ||
    s.includes('redhat') ||
    s.includes('red-hat') ||
    s.includes('red hat')
  ) {
    return 'rhel';
  }
  if (
    s.includes('oraclelinux') ||
    s.includes('oracle') ||
    /(^|[^a-z])ol[-_.]?\d/.test(s)
  ) {
    return 'oracle';
  }
  return undefined;
}

/**
 * Infer a guest OS family from a CDI DataSource (or similar) object.
 * Prefers Virtualization preference/os labels, then name / display-name,
 * then other label keys. Does not scan arbitrary annotation URLs (those
 * often contain redhat.com and would mis-label every image as RHEL).
 */
export function detectOsFamily(ds: DetectableSource): OsFamily {
  const labels = ds.metadata.labels || {};
  const annotations = ds.metadata.annotations || {};

  const preferenceBits = PREFERENCE_LABELS.map((key) => labels[key]).filter(Boolean);
  const nameBits = [ds.metadata.name, annotations['openshift.io/display-name']];
  const labelBits = [...Object.keys(labels), ...Object.values(labels)];
  const extraBits = [annotations['description']];

  for (const group of [preferenceBits, nameBits, labelBits, extraBits]) {
    const matched = matchOs(group.filter(Boolean).join(' '));
    if (matched) {
      return matched;
    }
  }
  return 'linux';
}
