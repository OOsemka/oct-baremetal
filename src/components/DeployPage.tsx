import {
  K8sResourceCommon,
  k8sPatch,
  k8sCreate,
  k8sDelete,
  useK8sWatchResource,
  ListPageHeader,
  DocumentTitle,
  consoleFetchJSON,
} from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import {
  PageSection,
  Button,
  Alert,
  Spinner,
  Gallery,
  GalleryItem,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  FormGroup,
  Form,
  TextInput,
  ExpandableSection,
  Split,
  SplitItem,
  Label,
  Stack,
  StackItem,
  HelperText,
  HelperTextItem,
  Bullseye,
  ActionGroup,
  DescriptionList,
  DescriptionListGroup,
  DescriptionListTerm,
  DescriptionListDescription,
  Divider,
  Title,
  Breadcrumb,
  BreadcrumbItem,
  FormHelperText,
  Switch,
  Tooltip,
  Progress,
  ProgressSize,
  ProgressMeasureLocation,
} from '@patternfly/react-core';
import {
  CubesIcon,
  ServerIcon,
  NetworkIcon,
  InfoCircleIcon,
  DownloadIcon,
} from '@patternfly/react-icons';
import React, { useState, useMemo, useEffect, useCallback, useRef, FC } from 'react';

import {
  BareMetalHostModel,
  BareMetalHostKind,
  DataSourceModel,
  DataSourceKind,
  DataImportCronModel,
  DataImportCronKind,
  SecretModel,
  VIRTUALIZATION_OS_IMAGES_NS,
  getProvisioningState,
  getHardwareSummary,
  getSystemVendorInfo,
} from '../utils/k8s-resources';

import { detectOsFamily, OsIcon } from './os-icons';
import dashboardLogger from '../utils/logger';
import { nmstateToKeyfiles } from '../utils/nmstate-to-keyfiles';
import {
  isHttpUrl,
  isClusterInternalUrl,
  resolveBareMetalImageUrls,
} from '../utils/image-cache-url';

import './baremetal-nodes.css';

// Path segment `oct-baremetal` is consolePlugin.name — do not rename.
const DISCOVERY_SERVICE_URL = '/api/proxy/plugin/oct-baremetal/discovery-service';

type ImageCacheStatus = {
  name: string;
  phase: 'queued' | 'exporting' | 'downloading' | 'ready' | 'error';
  downloadUrl?: string;
  checksumUrl?: string;
  externalUrl?: string;
  externalChecksumUrl?: string;
  sha256?: string;
  sizeBytes?: number;
  bytesDownloaded?: number;
  totalBytes?: number;
  statusMessage?: string;
  error?: string;
};

const SOURCE_URL_ANNOTATIONS = [
  'cdi.kubevirt.io/storage.import.endpoint',
  'cdi.kubevirt.io/storage.import.source',
];

function extractSourceUrl(ds: DataSourceKind): string | undefined {
  const annotations = ds.metadata.annotations;
  if (!annotations) return undefined;
  for (const key of SOURCE_URL_ANNOTATIONS) {
    if (annotations[key]) return annotations[key];
  }
  for (const [key, value] of Object.entries(annotations)) {
    if (
      (key.includes('source') || key.includes('import') || key.includes('url')) &&
      (value.startsWith('http://') || value.startsWith('https://'))
    ) {
      return value;
    }
  }
  return undefined;
}

function extractDicSourceUrl(dic: DataImportCronKind): { url: string; type: 'http' | 'registry' } | undefined {
  const source = dic.spec?.template?.spec?.source;
  if (!source) return undefined;
  if (source.http?.url) {
    return { url: source.http.url, type: 'http' };
  }
  if (source.registry?.url) {
    return { url: source.registry.url, type: 'registry' };
  }
  if (source.registry?.imageStream) {
    const dockerRef = dic.metadata?.annotations?.['cdi.kubevirt.io/storage.import.imageStreamDockerRef'];
    const url = dockerRef || `imagestream://${source.registry.imageStream}`;
    return { url, type: 'registry' };
  }
  return undefined;
}

function suggestChecksumUrl(imageUrl: string): string {
  if (!imageUrl) return '';
  return `${imageUrl}.sha256sum`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function parsePathParams(): { ns: string; name: string } {
  const path = window.location.pathname;
  const match = path.match(/\/baremetal\/nodes\/deploy\/([^/]+)\/([^/]+)/);
  if (match) {
    return { ns: match[1], name: match[2] };
  }
  return { ns: '', name: '' };
}

const getImageDisplayName = (ds: DataSourceKind): string => {
  const name = ds.metadata.name;
  return name
    .replace(/-\d+$/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

type ImageSourceKind = 'http' | 'registry' | 'pvc' | 'cached';

const sourceBadge = (
  kind: ImageSourceKind,
): { label: string; color: 'green' | 'orange' | 'grey' | 'blue' } => {
  switch (kind) {
    case 'cached':
      return { label: 'Cached', color: 'blue' };
    case 'registry':
      return { label: 'Registry', color: 'orange' };
    case 'http':
      return { label: 'HTTP', color: 'green' };
    default:
      return { label: 'PVC', color: 'grey' };
  }
};

const DeployPage: FC = () => {
  const { t } = useTranslation('plugin__oct-baremetal');
  const { ns, name } = useMemo(() => parsePathParams(), []);

  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [imageChecksum, setImageChecksum] = useState('');
  const [checksumTouched, setChecksumTouched] = useState(false);
  const [sshKey, setSshKey] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [reuseNetworkConfig, setReuseNetworkConfig] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<ImageCacheStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [bmhList, bmhLoaded, bmhError] = useK8sWatchResource<K8sResourceCommon[]>({
    groupVersionKind: {
      group: BareMetalHostModel.apiGroup,
      version: BareMetalHostModel.apiVersion,
      kind: BareMetalHostModel.kind,
    },
    namespace: ns,
    isList: true,
  });

  const bmh = useMemo(() => {
    if (!bmhLoaded || !bmhList) return null;
    return (bmhList as BareMetalHostKind[]).find(
      (h) => h.metadata.name === name && h.metadata.namespace === ns,
    ) || null;
  }, [bmhList, bmhLoaded, name, ns]);

  const preprovNetworkSecretName = bmh?.spec?.preprovisioningNetworkDataName;

  const [nmstateSecretList, nmstateSecretLoaded] = useK8sWatchResource<K8sResourceCommon[]>(
    preprovNetworkSecretName
      ? {
          groupVersionKind: {
            group: '',
            version: 'v1',
            kind: 'Secret',
          },
          namespace: ns,
          isList: true,
        }
      : { groupVersionKind: { group: '', version: 'v1', kind: 'Secret' }, isList: false, namespace: '', name: '' },
  );

  const nmstateSecretData = useMemo(() => {
    if (!preprovNetworkSecretName || !nmstateSecretLoaded || !nmstateSecretList) return null;
    const secrets = nmstateSecretList as Array<K8sResourceCommon & { data?: Record<string, string> }>;
    const secret = secrets.find(
      (s) => s.metadata?.name === preprovNetworkSecretName && s.metadata?.namespace === ns,
    );
    if (!secret?.data?.nmstate) return null;
    try {
      return atob(secret.data.nmstate);
    } catch {
      return null;
    }
  }, [nmstateSecretList, nmstateSecretLoaded, preprovNetworkSecretName, ns]);

  const hasNetworkConfig = Boolean(preprovNetworkSecretName && nmstateSecretData);

  useEffect(() => {
    if (hasNetworkConfig) {
      setReuseNetworkConfig(true);
    }
  }, [hasNetworkConfig]);

  const [dataSources, dsLoaded] = useK8sWatchResource<K8sResourceCommon[]>({
    groupVersionKind: {
      group: DataSourceModel.apiGroup,
      version: DataSourceModel.apiVersion,
      kind: DataSourceModel.kind,
    },
    namespace: VIRTUALIZATION_OS_IMAGES_NS,
    isList: true,
  });

  const [dataImportCrons, dicLoaded, dicError] = useK8sWatchResource<K8sResourceCommon[]>({
    groupVersionKind: {
      group: DataImportCronModel.apiGroup,
      version: DataImportCronModel.apiVersion,
      kind: DataImportCronModel.kind,
    },
    namespace: VIRTUALIZATION_OS_IMAGES_NS,
    isList: true,
  });

  useEffect(() => {
    if (dicError) {
      dashboardLogger.error('DEPLOY', 'Failed to watch DataImportCrons', String(dicError));
    }
  }, [dicError]);

  useEffect(() => {
    if (dicLoaded && dataImportCrons) {
      const dics = dataImportCrons as DataImportCronKind[];
      dashboardLogger.info('DEPLOY', `DataImportCrons loaded: ${dics.length} found`, dics.map(d => {
        const src = extractDicSourceUrl(d);
        return `${d.metadata.name} → ${src ? `${src.type}:${src.url.substring(0, 80)}` : 'no-source'}`;
      }).join(' | '));
    }
  }, [dicLoaded, dataImportCrons]);

  const dicByManagedDs = useMemo(() => {
    if (!dicLoaded || !dataImportCrons) return new Map<string, DataImportCronKind>();
    const map = new Map<string, DataImportCronKind>();
    for (const dic of dataImportCrons as DataImportCronKind[]) {
      const managedDs = dic.spec?.managedDataSource || dic.metadata.name;
      map.set(managedDs, dic);
    }
    return map;
  }, [dataImportCrons, dicLoaded]);

  const dicByName = useMemo(() => {
    if (!dicLoaded || !dataImportCrons) return new Map<string, DataImportCronKind>();
    const map = new Map<string, DataImportCronKind>();
    for (const dic of dataImportCrons as DataImportCronKind[]) {
      map.set(dic.metadata.name, dic);
    }
    return map;
  }, [dataImportCrons, dicLoaded]);

  const images = useMemo(() => {
    if (!dsLoaded || !dataSources) return [];
    return (dataSources as DataSourceKind[]).filter((ds) => {
      const readyCondition = ds.status?.conditions?.find(
        (c) => c.type === 'Ready',
      );
      return readyCondition?.status === 'True';
    });
  }, [dataSources, dsLoaded]);

  const getResolvedImageUrl = (ds: DataSourceKind): { url: string; type: 'http' | 'registry' | 'annotation' } | undefined => {
    const annotationUrl = extractSourceUrl(ds);
    if (annotationUrl) return { url: annotationUrl, type: 'annotation' };

    let dic = dicByManagedDs.get(ds.metadata.name);
    if (!dic) {
      const dicLabel = ds.metadata.labels?.['cdi.kubevirt.io/dataImportCron'];
      if (dicLabel) {
        dic = dicByName.get(dicLabel);
      }
    }
    if (dic) {
      const dicSource = extractDicSourceUrl(dic);
      if (dicSource) return { url: dicSource.url, type: dicSource.type };
    }
    return undefined;
  };

  // Determine if the selected image needs preparation (PVC-only or registry)
  const selectedDs = useMemo(() => {
    if (!selectedImage || !images.length) return null;
    return images.find((ds) => ds.metadata.name === selectedImage) || null;
  }, [selectedImage, images]);

  const selectedImageNeedsPrep = useMemo(() => {
    if (!selectedDs) return false;
    const resolved = getResolvedImageUrl(selectedDs);
    return !resolved || resolved.type === 'registry';
  }, [selectedDs, dicByManagedDs, dicByName]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const applyReadyCacheUrls = useCallback((status: ImageCacheStatus): boolean => {
    const resolved = resolveBareMetalImageUrls(status, '', '', status.name);
    if ('error' in resolved) {
      dashboardLogger.error(
        'DEPLOY',
        'Cached image has no URL reachable from bare metal',
        `downloadUrl: ${status.downloadUrl || 'none'}, externalUrl: ${status.externalUrl || 'none'}`,
      );
      setImageUrl('');
      setImageChecksum('');
      setChecksumTouched(false);
      return false;
    }
    setImageUrl(resolved.url);
    setImageChecksum(resolved.checksum);
    setChecksumTouched(true);
    dashboardLogger.info(
      'DEPLOY',
      'Using bare-metal-reachable image URL',
      `source: ${resolved.source}, url: ${resolved.url}, checksum: ${resolved.checksum}`,
    );
    return true;
  }, []);

  // Clean up poller on unmount
  useEffect(() => stopPolling, [stopPolling]);

  const pollCacheStatus = useCallback((imageName: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const status: ImageCacheStatus = await consoleFetchJSON(
          `${DISCOVERY_SERVICE_URL}/api/v1/image-cache/status/${imageName}`,
        );
        setCacheStatus(status);

        if (status.phase === 'ready') {
          stopPolling();
          applyReadyCacheUrls(status);
        } else if (status.phase === 'error') {
          stopPolling();
          dashboardLogger.error('DEPLOY', 'Image preparation failed', status.error || 'unknown');
        }
      } catch {
        // network error — keep polling
      }
    }, 3000);
  }, [stopPolling, applyReadyCacheUrls]);

  const handlePrepareImage = useCallback(async () => {
    if (!selectedDs) return;
    const dsName = selectedDs.metadata.name;
    dashboardLogger.info('DEPLOY', 'Preparing image for bare metal', `dataSource: ${dsName}`);

    setCacheStatus({ name: dsName, phase: 'queued' });

    try {
      const status: ImageCacheStatus = await consoleFetchJSON.post(
        `${DISCOVERY_SERVICE_URL}/api/v1/image-cache/prepare`,
        {
          dataSourceName: dsName,
          namespace: VIRTUALIZATION_OS_IMAGES_NS,
        },
      );
      setCacheStatus(status);

      if (status.phase === 'ready') {
        applyReadyCacheUrls(status);
      } else {
        pollCacheStatus(dsName);
      }
    } catch (err) {
      setCacheStatus({ name: dsName, phase: 'error', error: String(err) });
    }
  }, [selectedDs, pollCacheStatus, applyReadyCacheUrls]);

  useEffect(() => {
    if (imageUrl && !checksumTouched) {
      setImageChecksum(suggestChecksumUrl(imageUrl));
    }
  }, [imageUrl, checksumTouched]);

  const handleImageCardClick = (ds: DataSourceKind) => {
    const isAlreadySelected = selectedImage === ds.metadata.name;
    if (isAlreadySelected) {
      setSelectedImage(null);
      stopPolling();
      setCacheStatus(null);
      dashboardLogger.info('DEPLOY', 'Image deselected', `name: ${ds.metadata.name}`);
      return;
    }
    setSelectedImage(ds.metadata.name);
    stopPolling();

    const resolved = getResolvedImageUrl(ds);
    dashboardLogger.info('DEPLOY', 'Image card clicked', `name: ${ds.metadata.name}, resolved: ${resolved ? `${resolved.type} → ${resolved.url}` : 'none'}`);
    if (resolved && resolved.type !== 'registry') {
      if (isClusterInternalUrl(resolved.url)) {
        setImageUrl('');
        setImageChecksum('');
        setCacheStatus(null);
        dashboardLogger.warn(
          'DEPLOY',
          'Source URL is cluster-internal; not auto-filling for bare metal',
          `url: ${resolved.url}`,
        );
      } else {
        setImageUrl(resolved.url);
        setChecksumTouched(false);
        setImageChecksum(suggestChecksumUrl(resolved.url));
        setCacheStatus(null);
        dashboardLogger.info('DEPLOY', 'Image URL auto-filled', `url: ${resolved.url}`);
      }
    } else {
      setImageUrl('');
      setImageChecksum('');
      // Check if this image is already cached
      setCacheStatus(null);
      consoleFetchJSON(`${DISCOVERY_SERVICE_URL}/api/v1/image-cache/status/${ds.metadata.name}`)
        .then((status: ImageCacheStatus | null) => {
          if (status && status.phase === 'ready') {
            setCacheStatus(status);
            applyReadyCacheUrls(status);
          } else if (status && status.phase !== 'error') {
            setCacheStatus(status);
            pollCacheStatus(ds.metadata.name);
          }
        })
        .catch(() => { /* cache check is best-effort */ });

      if (resolved?.type === 'registry') {
        dashboardLogger.warn('DEPLOY', 'Registry image selected — checking cache', `source: ${resolved.url}`);
      } else {
        dashboardLogger.warn('DEPLOY', 'PVC-only image selected — checking cache', `name: ${ds.metadata.name}`);
      }
    }
  };

  const isValidUrl = (url: string): boolean => isHttpUrl(url) && !isClusterInternalUrl(url);

  const buildUserDataSecret = (): object => {
    if (!bmh) return {};
    const cloudConfig = [
      '#cloud-config',
      `hostname: ${bmh.metadata.name}`,
      `fqdn: ${bmh.metadata.name}`,
      'users:',
      '  - name: cloud-admin',
    ];

    if (sshKey) {
      cloudConfig.push(
        '    ssh_authorized_keys:',
        `      - ${sshKey}`,
      );
    }

    cloudConfig.push(
      "    sudo: ['ALL=(ALL) NOPASSWD:ALL']",
      '    shell: /bin/bash',
      '    lock_passwd: false',
      'disable_root: false',
      'ssh_pwauth: true',
    );

    if (adminPassword) {
      cloudConfig.push(
        'chpasswd:',
        '  list: |',
        `    cloud-admin:${adminPassword}`,
        '  expire: False',
      );
    }

    if (reuseNetworkConfig && nmstateSecretData) {
      const keyfiles = nmstateToKeyfiles(nmstateSecretData);
      if (keyfiles.length > 0) {
        cloudConfig.push('write_files:');
        for (const kf of keyfiles) {
          cloudConfig.push(
            `  - path: /etc/NetworkManager/system-connections/${kf.filename}`,
            '    permissions: "0600"',
            '    content: |',
          );
          for (const line of kf.content.split('\n')) {
            cloudConfig.push(`      ${line}`);
          }
        }

        const ourFiles = keyfiles.map((kf) => kf.filename).join(' ');
        cloudConfig.push(
          'runcmd:',
          '  - |',
          '    #!/bin/bash',
          '    set -uo pipefail',
          '    LOG=/var/log/baremetal-network-setup.log',
          '    exec >> "$LOG" 2>&1',
          '    echo "$(date) === Starting network configuration ==="',
          `    OUR_FILES="${ourFiles}"`,
          '    echo "$(date) Our keyfiles: $OUR_FILES"',
          '    systemctl stop NetworkManager',
          '    echo "$(date) NetworkManager stopped"',
          '    cd /etc/NetworkManager/system-connections/',
          '    for f in *; do',
          '      [ -e "$f" ] || continue',
          '      case " $OUR_FILES " in',
          '        *" $f "*) echo "$(date) Keeping: $f" ;;',
          '        *) rm -f "$f"; echo "$(date) Removed conflicting: $f" ;;',
          '      esac',
          '    done',
          '    chmod 600 *.nmconnection 2>/dev/null || true',
          '    systemctl start NetworkManager',
          '    echo "$(date) NetworkManager restarted, waiting for connections..."',
          '    sleep 10',
          '    echo "$(date) === Network setup complete ==="',
          '    echo "--- Active connections ---"',
          '    nmcli -t connection show --active 2>&1 || true',
          '    echo "--- IP addresses ---"',
          '    ip -br addr show 2>&1 || true',
        );
      }
    }

    const userData = cloudConfig.join('\n');
    const encodedUserData = btoa(userData);

    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: `user-data-${bmh.metadata.name}-deploy`,
        namespace: bmh.metadata.namespace,
        labels: {
          'environment.metal3.io': 'baremetal',
          'app.kubernetes.io/managed-by': 'oct-baremetal',
        },
      },
      type: 'Opaque',
      data: {
        userData: encodedUserData,
      },
    };
  };

  const needsUserData = Boolean(sshKey || adminPassword || (reuseNetworkConfig && nmstateSecretData));

  const deployImageUrls = useMemo(
    () => resolveBareMetalImageUrls(cacheStatus, imageUrl, imageChecksum, selectedImage),
    [cacheStatus, imageUrl, imageChecksum, selectedImage],
  );

  const handleDeploy = async () => {
    setSubmitted(true);
    if (!bmh) return;

    dashboardLogger.info('DEPLOY', 'Deploy button clicked', `host: ${bmh.metadata.name}, imageUrl: "${imageUrl}", checksum: "${imageChecksum}", selectedImage: ${selectedImage || 'none'}, reuseNetwork: ${reuseNetworkConfig}`);

    if (!isHttpUrl(imageUrl) && cacheStatus?.phase !== 'ready') {
      dashboardLogger.error('DEPLOY', 'Validation failed — invalid image URL', `imageUrl: "${imageUrl}"`);
      setError(t('Image URL must start with http:// or https://.'));
      return;
    }

    const resolved = resolveBareMetalImageUrls(
      cacheStatus,
      imageUrl,
      imageChecksum,
      selectedImage,
    );

    if ('error' in resolved) {
      if (resolved.error === 'not-reachable') {
        dashboardLogger.error(
          'DEPLOY',
          'Blocked deploy — image is not reachable from bare metal',
          `imageUrl: "${imageUrl}", externalUrl: ${cacheStatus?.externalUrl || 'none'}, downloadUrl: ${cacheStatus?.downloadUrl || 'none'}`,
        );
        setError(
          t(
            'This image is not reachable from bare metal. IPA cannot resolve cluster-internal DNS names (*.svc). Use the image-cache Route or another HTTP(S) URL the host can fetch.',
          ),
        );
        return;
      }
      if (!isHttpUrl(imageUrl)) {
        dashboardLogger.error('DEPLOY', 'Validation failed — invalid image URL', `imageUrl: "${imageUrl}"`);
        setError(t('Image URL must start with http:// or https://.'));
        return;
      }
      setError(
        t('Checksum URL is required by Metal3. Provide an http:// or https:// URL to a sha256sum file.'),
      );
      return;
    }

    if (isClusterInternalUrl(resolved.url) || isClusterInternalUrl(resolved.checksum)) {
      dashboardLogger.error(
        'DEPLOY',
        'Blocked deploy — refused to write cluster-internal URL to BareMetalHost',
        `url: ${resolved.url}, checksum: ${resolved.checksum}`,
      );
      setError(
        t(
          'This image is not reachable from bare metal. IPA cannot resolve cluster-internal DNS names (*.svc). Use the image-cache Route or another HTTP(S) URL the host can fetch.',
        ),
      );
      return;
    }

    setDeploying(true);
    setError(null);
    const isCachedImage = resolved.url.includes('image-cache');
    dashboardLogger.info(
      'DEPLOY',
      'Final BMH image URL',
      `source: ${resolved.source}, url: ${resolved.url}, checksum: ${resolved.checksum}, format: ${isCachedImage ? 'raw' : 'auto-detect'}`,
    );

    try {
      if (needsUserData) {
        const secretPayload = buildUserDataSecret();
        try {
          await k8sCreate({
            model: SecretModel,
            ns: bmh.metadata.namespace,
            data: secretPayload as K8sResourceCommon,
          });
        } catch (createErr: unknown) {
          if (String(createErr).includes('already exists')) {
            dashboardLogger.info('DEPLOY', 'Secret already exists, deleting and recreating', `secret: user-data-${bmh.metadata.name}-deploy`);
            await k8sDelete({
              model: SecretModel,
              resource: secretPayload as K8sResourceCommon,
            });
            await k8sCreate({
              model: SecretModel,
              ns: bmh.metadata.namespace,
              data: secretPayload as K8sResourceCommon,
            });
          } else {
            throw createErr;
          }
        }
      }

      const imageValue: Record<string, string> = {
        url: resolved.url,
        checksum: resolved.checksum,
        checksumType: 'sha256',
      };
      if (isCachedImage) {
        imageValue.format = 'raw';
      }

      const patchPayload: object[] = [
        {
          op: 'add',
          path: '/spec/image',
          value: imageValue,
        },
        {
          op: 'replace',
          path: '/spec/online',
          value: true,
        },
      ];

      if (needsUserData) {
        patchPayload.push({
          op: 'add',
          path: '/spec/userData',
          value: {
            name: `user-data-${bmh.metadata.name}-deploy`,
            namespace: bmh.metadata.namespace,
          },
        });
      }

      if (reuseNetworkConfig && preprovNetworkSecretName) {
        patchPayload.push({
          op: 'add',
          path: '/spec/networkData',
          value: {
            name: preprovNetworkSecretName,
            namespace: bmh.metadata.namespace,
          },
        });
      }

      await k8sPatch({
        model: BareMetalHostModel,
        resource: bmh as K8sResourceCommon,
        data: patchPayload,
      });

      dashboardLogger.info('DEPLOY', 'Host deployment initiated successfully', `host: ${bmh.metadata.name}`);
      setSuccess(true);
      setTimeout(() => {
        window.location.href = '/baremetal/nodes';
      }, 2000);
    } catch (err) {
      dashboardLogger.error('DEPLOY', 'Deployment failed', String(err));
      setError(String(err));
    } finally {
      setDeploying(false);
    }
  };

  const handleCancel = () => {
    window.location.href = '/baremetal/nodes';
  };

  if (!bmhLoaded) {
    return (
      <PageSection>
        <Bullseye>
          <Spinner size="xl" />
        </Bullseye>
      </PageSection>
    );
  }

  if (bmhError || !bmh) {
    return (
      <PageSection>
        <Alert variant="danger" title={t('Error loading BareMetalHost')} isInline>
          {bmhError ? String(bmhError) : t('BareMetalHost not found:') + ` ${ns}/${name}`}
        </Alert>
        <br />
        <Button variant="link" onClick={handleCancel}>
          {t('Back to inventory')}
        </Button>
      </PageSection>
    );
  }

  const state = getProvisioningState(bmh);

  return (
    <>
      <DocumentTitle>{t('Deploy Node:') + ` ${bmh.metadata.name}`}</DocumentTitle>

      <PageSection type="breadcrumb">
        <Breadcrumb>
          <BreadcrumbItem
            component="a"
            onClick={(e) => { e.preventDefault(); handleCancel(); }}
          >
            {t('Baremetal Nodes')}
          </BreadcrumbItem>
          <BreadcrumbItem isActive>
            {t('Deploy')} {bmh.metadata.name}
          </BreadcrumbItem>
        </Breadcrumb>
      </PageSection>

      <ListPageHeader title={`${t('Deploy Node:')} ${bmh.metadata.name}`} />

      <PageSection>
        <Stack hasGutter>
          {error && (
            <StackItem>
              <Alert variant="danger" title={t('Deployment error')} isInline>
                {error}
              </Alert>
            </StackItem>
          )}

          {success && (
            <StackItem>
              <Alert variant="success" title={t('Deployment initiated')} isInline>
                {t('The image has been assigned to')} {bmh.metadata.name}.{' '}
                {t('Metal3 will begin provisioning shortly. Redirecting...')}
              </Alert>
            </StackItem>
          )}

          {/* Node info summary */}
          <StackItem>
            <Card>
              <CardTitle>
                <Split hasGutter>
                  <SplitItem><ServerIcon /></SplitItem>
                  <SplitItem><Title headingLevel="h3">{t('Node Information')}</Title></SplitItem>
                </Split>
              </CardTitle>
              <CardBody>
                <DescriptionList isHorizontal>
                  <DescriptionListGroup>
                    <DescriptionListTerm>{t('Name')}</DescriptionListTerm>
                    <DescriptionListDescription>{bmh.metadata.name}</DescriptionListDescription>
                  </DescriptionListGroup>
                  <DescriptionListGroup>
                    <DescriptionListTerm>{t('Namespace')}</DescriptionListTerm>
                    <DescriptionListDescription>{bmh.metadata.namespace}</DescriptionListDescription>
                  </DescriptionListGroup>
                  <DescriptionListGroup>
                    <DescriptionListTerm>{t('State')}</DescriptionListTerm>
                    <DescriptionListDescription>
                      <Label isCompact>{state}</Label>
                    </DescriptionListDescription>
                  </DescriptionListGroup>
                  <DescriptionListGroup>
                    <DescriptionListTerm>{t('Hardware')}</DescriptionListTerm>
                    <DescriptionListDescription>{getHardwareSummary(bmh)}</DescriptionListDescription>
                  </DescriptionListGroup>
                  <DescriptionListGroup>
                    <DescriptionListTerm>{t('Vendor')}</DescriptionListTerm>
                    <DescriptionListDescription>{getSystemVendorInfo(bmh)}</DescriptionListDescription>
                  </DescriptionListGroup>
                  <DescriptionListGroup>
                    <DescriptionListTerm>{t('BMC Address')}</DescriptionListTerm>
                    <DescriptionListDescription>
                      <code>{bmh.spec.bmc?.address || '—'}</code>
                    </DescriptionListDescription>
                  </DescriptionListGroup>
                  {preprovNetworkSecretName && (
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('Network Config')}</DescriptionListTerm>
                      <DescriptionListDescription>
                        <Label isCompact color="blue" icon={<NetworkIcon />}>
                          {preprovNetworkSecretName}
                        </Label>
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                  )}
                </DescriptionList>
              </CardBody>
            </Card>
          </StackItem>

          {/* NMState network config reuse */}
          {hasNetworkConfig && (
            <StackItem>
              <Card>
                <CardTitle>
                  <Split hasGutter>
                    <SplitItem><NetworkIcon /></SplitItem>
                    <SplitItem><Title headingLevel="h3">{t('Network Configuration')}</Title></SplitItem>
                  </Split>
                </CardTitle>
                <CardBody>
                  <Stack hasGutter>
                    <StackItem>
                      <Split hasGutter>
                        <SplitItem isFilled>
                          <div>
                            <strong>{t('Reuse registration network config for deployment')}</strong>
                            <HelperText>
                              <HelperTextItem>
                                {t('This host was registered with static NMState networking (secret: {{secretName}}). Enable this to apply the same network configuration during deployment via cloud-init.', { secretName: preprovNetworkSecretName })}
                              </HelperTextItem>
                            </HelperText>
                          </div>
                        </SplitItem>
                        <SplitItem>
                          <Switch
                            id="reuse-network-switch"
                            isChecked={reuseNetworkConfig}
                            onChange={(_event, checked) => setReuseNetworkConfig(checked)}
                            label={reuseNetworkConfig ? t('Enabled') : t('Disabled')}
                          />
                        </SplitItem>
                      </Split>
                    </StackItem>
                    {reuseNetworkConfig && (
                      <StackItem>
                        <Alert variant="info" title={t('How network config is applied')} isInline isPlain>
                          <p>
                            {t('The NMState configuration will be converted to NetworkManager keyfiles and written to /etc/NetworkManager/system-connections/ via cloud-init. NetworkManager reads them natively on boot without any extra tooling.')}
                          </p>
                        </Alert>
                      </StackItem>
                    )}
                  </Stack>
                </CardBody>
              </Card>
            </StackItem>
          )}

          {/* Image Configuration */}
          <StackItem>
            <Card>
              <CardTitle>
                <Split hasGutter>
                  <SplitItem><CubesIcon /></SplitItem>
                  <SplitItem><Title headingLevel="h3">{t('Image Configuration')}</Title></SplitItem>
                </Split>
              </CardTitle>
              <CardBody>
                <Stack hasGutter>
                  <StackItem>
                    <Form>
                      <FormGroup
                        label={t('Image URL')}
                        isRequired
                        fieldId="image-url"
                      >
                        <TextInput
                          id="image-url"
                          value={imageUrl}
                          onChange={(_event, value) => {
                            setImageUrl(value);
                            if (value) setSelectedImage(null);
                          }}
                          placeholder="https://your-server.com/images/rhel-9.4-x86_64-kvm.qcow2"
                          validated={submitted && !isValidUrl(imageUrl) ? 'error' : 'default'}
                        />
                        <FormHelperText>
                          <HelperText>
                            <HelperTextItem variant={submitted && !isValidUrl(imageUrl) ? 'error' : 'default'}>
                              {submitted && !isHttpUrl(imageUrl)
                                ? t('Required. Must be an HTTP or HTTPS URL.')
                                : submitted && isClusterInternalUrl(imageUrl)
                                  ? t('This URL is cluster-internal (*.svc). IPA on bare metal cannot resolve it.')
                                  : t('Metal3/Ironic requires an HTTP or HTTPS URL to a qcow2 or raw disk image.')}
                            </HelperTextItem>
                          </HelperText>
                        </FormHelperText>
                      </FormGroup>

                      <FormGroup
                        label={t('Checksum URL')}
                        isRequired
                        fieldId="image-checksum"
                      >
                        <TextInput
                          id="image-checksum"
                          value={imageChecksum}
                          onChange={(_event, value) => {
                            setImageChecksum(value);
                            setChecksumTouched(true);
                          }}
                          placeholder="https://your-server.com/images/rhel-9.4-x86_64-kvm.qcow2.sha256sum"
                          validated={submitted && !isValidUrl(imageChecksum) ? 'error' : 'default'}
                        />
                        <FormHelperText>
                          <HelperText>
                            <HelperTextItem variant={submitted && !isValidUrl(imageChecksum) ? 'error' : 'default'}>
                              {submitted && !isHttpUrl(imageChecksum)
                                ? t('Required. Metal3 admission webhook rejects deployments without a checksum.')
                                : submitted && isClusterInternalUrl(imageChecksum)
                                  ? t('This URL is cluster-internal (*.svc). IPA on bare metal cannot resolve it.')
                                  : t('URL to a sha256sum file (e.g. image.qcow2.sha256sum) or an inline sha256 hash. Required by Metal3.')}
                            </HelperTextItem>
                          </HelperText>
                        </FormHelperText>
                      </FormGroup>
                    </Form>
                  </StackItem>

                  <StackItem>
                    <Divider />
                  </StackItem>

                  {/* DataSource reference images */}
                  <StackItem>
                    <ExpandableSection
                      toggleText={t('Available OS images from OpenShift Virtualization')}
                    >
                      <Stack hasGutter>
                        <StackItem>
                          <HelperText>
                            <HelperTextItem>
                              {t('These images are DataSources from OpenShift Virtualization. Click one to auto-fill the URL if the source is HTTP-accessible. Images sourced from container registries cannot be used directly for bare metal provisioning.')}
                            </HelperTextItem>
                          </HelperText>
                        </StackItem>
                        <StackItem>
                          {!dsLoaded ? (
                            <Spinner size="md" />
                          ) : images.length === 0 ? (
                            <Alert variant="info" title={t('No images available')} isInline isPlain>
                              {t('No ready DataSource images found in')} {VIRTUALIZATION_OS_IMAGES_NS}.
                            </Alert>
                          ) : (
                            <Gallery hasGutter minWidths={{ default: '220px' }}>
                              {images.map((ds) => {
                                const tileId = `bmh-os-tile-${ds.metadata.name}`;
                                const titleId = `${tileId}-title`;
                                const displayName = getImageDisplayName(ds);
                                const osFamily = detectOsFamily(ds);
                                const isCardSelected = selectedImage === ds.metadata.name;
                                const resolved = getResolvedImageUrl(ds);
                                const isCached = cacheStatus?.name === ds.metadata.name && cacheStatus.phase === 'ready';
                                const sourceKind: ImageSourceKind = isCached
                                  ? 'cached'
                                  : resolved
                                    ? resolved.type === 'registry'
                                      ? 'registry'
                                      : 'http'
                                    : 'pvc';
                                const badge = sourceBadge(sourceKind);
                                return (
                                  <GalleryItem key={ds.metadata.name}>
                                    <Card
                                      id={tileId}
                                      className="bmh-os-tile"
                                      isClickable
                                      isSelectable
                                      isSelected={isCardSelected}
                                      isFullHeight
                                    >
                                      <CardHeader
                                        selectableActions={{
                                          selectableActionId: `${tileId}-input`,
                                          selectableActionAriaLabelledby: titleId,
                                          name: 'bmh-os-image',
                                          isHidden: true,
                                          onChange: () => handleImageCardClick(ds),
                                        }}
                                      >
                                        <div className="bmh-os-tile-header">
                                          <OsIcon family={osFamily} />
                                          <Label isCompact color={badge.color}>
                                            {badge.label}
                                          </Label>
                                        </div>
                                      </CardHeader>
                                      <CardTitle id={titleId}>{displayName}</CardTitle>
                                      <CardBody>
                                        <code className="bmh-ds-name">{ds.metadata.name}</code>
                                        {resolved?.type === 'registry' && !isCached && (
                                          <div className="bmh-ds-source-url">
                                            <Tooltip content={t('This image is sourced from a container registry ({{url}}). Click to select it, then use "Prepare image" to cache it for bare metal deployment.', { url: resolved.url })}>
                                              <InfoCircleIcon className="bmh-ds-info-icon" />
                                            </Tooltip>
                                          </div>
                                        )}
                                        {resolved?.type === 'http' && (
                                          <div className="bmh-ds-resolved-url">
                                            <small>{resolved.url.length > 60 ? `${resolved.url.substring(0, 60)}...` : resolved.url}</small>
                                          </div>
                                        )}
                                      </CardBody>
                                    </Card>
                                  </GalleryItem>
                                );
                              })}
                            </Gallery>
                          )}
                        </StackItem>
                      </Stack>
                    </ExpandableSection>
                  </StackItem>

                  {/* Image preparation for PVC-only / registry images */}
                  {selectedImage && selectedImageNeedsPrep && (
                    <StackItem className="bmh-deploy-prep-section">
                      {(!cacheStatus || cacheStatus.name !== selectedImage) && (
                        <Alert variant="info" title={t('Image requires preparation')} isInline>
                          <Stack hasGutter>
                            <StackItem>
                              {t('This image is stored as a PVC and is not directly HTTP-accessible. To use it for bare metal deployment, it must be cached to an HTTP-accessible location.')}
                            </StackItem>
                            <StackItem>
                              <Button
                                variant="primary"
                                icon={<DownloadIcon />}
                                onClick={handlePrepareImage}
                              >
                                {t('Prepare image for deployment')}
                              </Button>
                            </StackItem>
                          </Stack>
                        </Alert>
                      )}

                      {cacheStatus && cacheStatus.name === selectedImage && cacheStatus.phase !== 'ready' && cacheStatus.phase !== 'error' && (
                        <Alert variant="info" title={t('Preparing image...')} isInline>
                          <Stack hasGutter>
                            <StackItem>
                              <Split hasGutter>
                                <SplitItem><Spinner size="md" /></SplitItem>
                                <SplitItem isFilled>
                                  {cacheStatus.statusMessage
                                    ? cacheStatus.statusMessage
                                    : cacheStatus.phase === 'queued'
                                      ? t('Queued — creating temporary PVC from snapshot...')
                                      : cacheStatus.phase === 'exporting'
                                        ? t('Creating VMExport resource...')
                                        : t('Downloading image and computing SHA-256 checksum...')}
                                </SplitItem>
                              </Split>
                            </StackItem>
                            {cacheStatus.phase === 'downloading' && cacheStatus.totalBytes && cacheStatus.totalBytes > 0 && (
                              <StackItem>
                                <Progress
                                  value={cacheStatus.bytesDownloaded || 0}
                                  max={cacheStatus.totalBytes}
                                  size={ProgressSize.sm}
                                  measureLocation={ProgressMeasureLocation.outside}
                                  label={`${formatBytes(cacheStatus.bytesDownloaded || 0)} / ${formatBytes(cacheStatus.totalBytes)}`}
                                  valueText={`${formatBytes(cacheStatus.bytesDownloaded || 0)} / ${formatBytes(cacheStatus.totalBytes)}`}
                                  aria-label={t('Image download progress')}
                                />
                              </StackItem>
                            )}
                            {cacheStatus.phase === 'downloading' && (!cacheStatus.totalBytes || cacheStatus.totalBytes === 0) && cacheStatus.bytesDownloaded && cacheStatus.bytesDownloaded > 0 && (
                              <StackItem>
                                <span className="bmh-deploy-progress-bytes">
                                  {t('Downloaded: {{size}}', { size: formatBytes(cacheStatus.bytesDownloaded) })}
                                </span>
                              </StackItem>
                            )}
                          </Stack>
                        </Alert>
                      )}

                      {cacheStatus && cacheStatus.name === selectedImage && cacheStatus.phase === 'ready' && (
                        <Alert
                          variant={'error' in deployImageUrls ? 'danger' : 'success'}
                          title={
                            'error' in deployImageUrls
                              ? t('Image is not reachable from bare metal')
                              : t('Image ready for deployment')
                          }
                          isInline
                        >
                          {'error' in deployImageUrls
                            ? t('This image is not reachable from bare metal. IPA cannot resolve cluster-internal DNS names (*.svc). Use the image-cache Route or another HTTP(S) URL the host can fetch.')
                            : t('Image cached and checksum computed. The URLs have been filled in above.')}
                        </Alert>
                      )}

                      {cacheStatus && cacheStatus.name === selectedImage && cacheStatus.phase === 'error' && (
                        <Alert variant="danger" title={t('Image preparation failed')} isInline>
                          <Stack hasGutter>
                            <StackItem>{cacheStatus.error}</StackItem>
                            <StackItem>
                              <Button variant="link" onClick={handlePrepareImage}>
                                {t('Retry')}
                              </Button>
                            </StackItem>
                          </Stack>
                        </Alert>
                      )}
                    </StackItem>
                  )}
                </Stack>
              </CardBody>
            </Card>
          </StackItem>

          {/* User configuration */}
          <StackItem>
            <Card>
              <CardTitle>
                <Title headingLevel="h3">{t('User Configuration')}</Title>
              </CardTitle>
              <CardBody>
                <ExpandableSection
                  toggleText={t('SSH keys and password (optional)')}
                  isExpanded={showAdvanced}
                  onToggle={(_event, expanded) => setShowAdvanced(expanded)}
                >
                  <Form className="bmh-deploy-user-form">
                    <FormGroup
                      label={t('SSH Public Key')}
                      fieldId="ssh-key"
                    >
                      <TextInput
                        id="ssh-key"
                        value={sshKey}
                        onChange={(_event, value) => setSshKey(value)}
                        placeholder="ssh-rsa AAAA... user@host"
                      />
                      <FormHelperText>
                        <HelperText>
                          <HelperTextItem>
                            {t('Will be injected into the cloud-admin user via cloud-init')}
                          </HelperTextItem>
                        </HelperText>
                      </FormHelperText>
                    </FormGroup>
                    <FormGroup
                      label={t('Admin Password')}
                      fieldId="admin-password"
                    >
                      <TextInput
                        id="admin-password"
                        type="password"
                        value={adminPassword}
                        onChange={(_event, value) => setAdminPassword(value)}
                        placeholder="Complex_P@ssw0rd_2026!"
                      />
                      <FormHelperText>
                        <HelperText>
                          <HelperTextItem>
                            {t('Password for the cloud-admin user. Use a complex password for RHEL 9.')}
                          </HelperTextItem>
                        </HelperText>
                      </FormHelperText>
                    </FormGroup>
                  </Form>
                </ExpandableSection>
              </CardBody>
            </Card>
          </StackItem>

          {/* Actions */}
          <StackItem>
            <ActionGroup className="bmh-deploy-actions">
              <Button
                variant="primary"
                onClick={handleDeploy}
                isDisabled={deploying || success}
                isLoading={deploying}
              >
                {deploying ? t('Deploying...') : t('Deploy')}
              </Button>
              <Button variant="link" onClick={handleCancel} isDisabled={deploying}>
                {t('Cancel')}
              </Button>
            </ActionGroup>
          </StackItem>
        </Stack>
      </PageSection>
    </>
  );
};

export default DeployPage;
