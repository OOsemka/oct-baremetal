import {
  K8sResourceCommon,
  k8sPatch,
  k8sCreate,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import {
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Button,
  Alert,
  Spinner,
  Gallery,
  GalleryItem,
  Card,
  CardBody,
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
} from '@patternfly/react-core';
import { CubesIcon, CheckCircleIcon } from '@patternfly/react-icons';
import React, { useState, useMemo, FC } from 'react';

import {
  BareMetalHostModel,
  BareMetalHostKind,
  DataSourceModel,
  DataSourceKind,
  SecretModel,
  VIRTUALIZATION_OS_IMAGES_NS,
} from '../utils/k8s-resources';

type DeployModalProps = {
  bmh: BareMetalHostKind;
  onClose: () => void;
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

const DeployModal: FC<DeployModalProps> = ({ bmh, onClose }) => {
  const { t } = useTranslation('plugin__oct-baremetal');

  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [imageChecksum, setImageChecksum] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [dataSources, dsLoaded] = useK8sWatchResource<K8sResourceCommon[]>({
    groupVersionKind: {
      group: DataSourceModel.apiGroup,
      version: DataSourceModel.apiVersion,
      kind: DataSourceModel.kind,
    },
    namespace: VIRTUALIZATION_OS_IMAGES_NS,
    isList: true,
  });

  const images = useMemo(() => {
    if (!dsLoaded || !dataSources) return [];
    return (dataSources as DataSourceKind[]).filter((ds) => {
      const readyCondition = ds.status?.conditions?.find(
        (c) => c.type === 'Ready',
      );
      return readyCondition?.status === 'True';
    });
  }, [dataSources, dsLoaded]);

  const getImageDisplayName = (ds: DataSourceKind): string => {
    const name = ds.metadata.name;
    return name
      .replace(/-\d+$/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  };

  const getImageOS = (ds: DataSourceKind): string => {
    const name = ds.metadata.name.toLowerCase();
    if (name.includes('rhel')) return 'RHEL';
    if (name.includes('centos')) return 'CentOS';
    if (name.includes('fedora')) return 'Fedora';
    if (name.includes('windows')) return 'Windows';
    if (name.includes('ubuntu')) return 'Ubuntu';
    return 'Linux';
  };

  const handleImageCardClick = (ds: DataSourceKind) => {
    const isAlreadySelected = selectedImage === ds.metadata.name;
    if (isAlreadySelected) {
      setSelectedImage(null);
      return;
    }
    setSelectedImage(ds.metadata.name);
    const sourceUrl = extractSourceUrl(ds);
    if (sourceUrl) {
      setImageUrl(sourceUrl);
      setImageChecksum('');
    }
  };

  const buildUserDataSecret = (): object => {
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

  const handleDeploy = async () => {
    setDeploying(true);
    setError(null);

    try {
      if (!imageUrl) {
        setError('Please provide an HTTP/HTTPS image URL. Metal3 requires a network-accessible image.');
        setDeploying(false);
        return;
      }

      if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
        setError('Image URL must start with http:// or https://. Metal3/Ironic requires an HTTP-accessible image.');
        setDeploying(false);
        return;
      }

      if (sshKey || adminPassword) {
        const secretPayload = buildUserDataSecret();
        await k8sCreate({
          model: SecretModel,
          data: secretPayload as K8sResourceCommon,
        });
      }

      const patchPayload: object[] = [
        {
          op: 'add',
          path: '/spec/image',
          value: {
            url: imageUrl,
            ...(imageChecksum ? { checksum: imageChecksum, checksumType: 'sha256' } : {}),
          },
        },
        {
          op: 'replace',
          path: '/spec/online',
          value: true,
        },
      ];

      if (sshKey || adminPassword) {
        patchPayload.push({
          op: 'add',
          path: '/spec/userData',
          value: {
            name: `user-data-${bmh.metadata.name}-deploy`,
            namespace: bmh.metadata.namespace,
          },
        });
      }

      await k8sPatch({
        model: BareMetalHostModel,
        resource: bmh as K8sResourceCommon,
        data: patchPayload,
      });

      setSuccess(true);
      setTimeout(onClose, 2000);
    } catch (err) {
      setError(String(err));
    } finally {
      setDeploying(false);
    }
  };

  const canDeploy = imageUrl.startsWith('http://') || imageUrl.startsWith('https://');

  return (
    <Modal
      variant="large"
      isOpen
      onClose={onClose}
    >
      <ModalHeader title={`${t('Deploy Node')}: ${bmh.metadata.name}`} />
      <ModalBody>
      <Stack hasGutter>
        {error && (
          <StackItem>
            <Alert variant="danger" title={t('Error')} isInline>
              {error}
            </Alert>
          </StackItem>
        )}

        {success && (
          <StackItem>
            <Alert variant="success" title={t('Deployment initiated')} isInline>
              The image has been assigned to {bmh.metadata.name}. Metal3 will begin
              provisioning shortly.
            </Alert>
          </StackItem>
        )}

        {/* Image URL - primary input */}
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
                validated={imageUrl && !canDeploy ? 'error' : 'default'}
              />
              <HelperText>
                <HelperTextItem variant={imageUrl && !canDeploy ? 'error' : 'default'}>
                  {t('Metal3/Ironic requires an HTTP or HTTPS URL to a qcow2 or raw disk image.')}
                </HelperTextItem>
              </HelperText>
            </FormGroup>
            <FormGroup label={t('Checksum URL (optional)')} fieldId="image-checksum">
              <TextInput
                id="image-checksum"
                value={imageChecksum}
                onChange={(_event, value) => setImageChecksum(value)}
                placeholder="https://your-server.com/images/rhel-9.4-x86_64-kvm.qcow2.sha256sum"
              />
            </FormGroup>
          </Form>
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
                    {t('These images are DataSources from OpenShift Virtualization. Click one to auto-fill the URL if the source is HTTP-accessible. Otherwise, provide the image URL manually above.')}
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
                  <div className="bmh-image-gallery-scroll">
                    <Gallery hasGutter minWidths={{ default: '220px' }} maxWidths={{ default: '300px' }}>
                      {images.map((ds) => {
                        const isSelected = selectedImage === ds.metadata.name;
                        const sourceUrl = extractSourceUrl(ds);
                        return (
                          <GalleryItem key={ds.metadata.name}>
                            <Card
                              className={`bmh-deploy-image-card${isSelected ? ' bmh-deploy-image-card--selected' : ''}`}
                              onClick={() => handleImageCardClick(ds)}
                            >
                              <CardTitle>
                                <Split hasGutter>
                                  <SplitItem>
                                    <CubesIcon />
                                  </SplitItem>
                                  <SplitItem isFilled>
                                    {getImageDisplayName(ds)}
                                  </SplitItem>
                                  <SplitItem>
                                    <Label isCompact>{getImageOS(ds)}</Label>
                                  </SplitItem>
                                  {isSelected && (
                                    <SplitItem>
                                      <CheckCircleIcon color="var(--pf-t--global--color--status--success--default, #3e8635)" />
                                    </SplitItem>
                                  )}
                                </Split>
                              </CardTitle>
                              <CardBody>
                                <code className="bmh-ds-name">{ds.metadata.name}</code>
                                {sourceUrl ? (
                                  <div className="bmh-ds-source-url">
                                    <Label isCompact color="green">HTTP source</Label>
                                  </div>
                                ) : (
                                  <div className="bmh-ds-source-url">
                                    <Label isCompact color="orange">PVC only</Label>
                                  </div>
                                )}
                              </CardBody>
                            </Card>
                          </GalleryItem>
                        );
                      })}
                    </Gallery>
                  </div>
                )}
              </StackItem>
            </Stack>
          </ExpandableSection>
        </StackItem>

        {/* User configuration */}
        <StackItem>
          <ExpandableSection
            toggleText={t('User configuration (optional)')}
            isExpanded={showAdvanced}
            onToggle={(_event, expanded) => setShowAdvanced(expanded)}
          >
            <Form>
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
                <HelperText>
                  <HelperTextItem>
                    {t('Will be injected into the cloud-admin user via cloud-init')}
                  </HelperTextItem>
                </HelperText>
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
                <HelperText>
                  <HelperTextItem>
                    {t('Password for the cloud-admin user. Use a complex password for RHEL 9.')}
                  </HelperTextItem>
                </HelperText>
              </FormGroup>
            </Form>
          </ExpandableSection>
        </StackItem>
      </Stack>
      </ModalBody>
      <ModalFooter>
        <Button
          key="deploy"
          variant="primary"
          onClick={handleDeploy}
          isDisabled={deploying || success || !canDeploy}
          isLoading={deploying}
        >
          {deploying ? t('Deploying...') : t('Deploy')}
        </Button>
        <Button key="cancel" variant="link" onClick={onClose}>
          {t('Cancel')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default DeployModal;
