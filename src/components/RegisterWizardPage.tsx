import React, { useState, useMemo, useCallback, FC } from 'react';
import {
  k8sCreate,
  K8sResourceCommon,
  ListPageHeader,
  DocumentTitle,
} from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import {
  PageSection,
  Wizard,
  WizardStep,
  Button,
  Alert,
  Spinner,
  Card,
  CardBody,
  CardTitle,
  FormGroup,
  Form,
  TextInput,
  FormSelect,
  FormSelectOption,
  Radio,
  Stack,
  StackItem,
  Split,
  SplitItem,
  Label,
  DescriptionList,
  DescriptionListGroup,
  DescriptionListTerm,
  DescriptionListDescription,
  Title,
  Breadcrumb,
  BreadcrumbItem,
  FormHelperText,
  HelperText,
  HelperTextItem,
  CodeBlock,
  CodeBlockCode,
  Bullseye,
  ActionGroup,
  Divider,
} from '@patternfly/react-core';
import {
  ServerIcon,
  CheckCircleIcon,
} from '@patternfly/react-icons';

import {
  BareMetalHostModel,
  SecretModel,
} from '../utils/k8s-resources';
import NMStateBuilder, { DiscoveredNic } from './NMStateBuilder';
import { toYaml } from '../utils/yaml';

import dashboardLogger from '../utils/logger';

import './baremetal-nodes.css';

// Path segment `oct-baremetal` is consolePlugin.name — do not rename.
const DISCOVERY_SERVICE_URL = '/api/proxy/plugin/oct-baremetal/discovery-service';

interface DiscoveredSystemInfo {
  model: string;
  manufacturer: string;
  serialNumber: string;
  cpuModel: string;
  cpuCores: number;
  ramGb: number;
  nics: DiscoveredNic[];
  storage: Array<{
    name: string;
    sizeGb: number;
    type: string;
    model: string;
    serialNumber?: string;
    wwn?: string;
    protocol?: string;
  }>;
  suggestedName: string;
  suggestedBootMac: string;
  bootMode: 'UEFI' | 'UEFISecureBoot' | 'legacy';
  detectedDriver: string;
  bmcAddress: string;
}

const RegisterWizardPage: FC = () => {
  const { t } = useTranslation('plugin__oct-baremetal');

  // Step 1: BMC Connection
  const [bmcAddress, setBmcAddress] = useState('');
  const [bmcFullAddress, setBmcFullAddress] = useState('');
  const [bmcUsername, setBmcUsername] = useState('');
  const [bmcPassword, setBmcPassword] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveredInfo, setDiscoveredInfo] = useState<DiscoveredSystemInfo | null>(null);

  // Step 2: Host Configuration
  const [hostName, setHostName] = useState('');
  const [namespace, setNamespace] = useState('cjanisze');
  const [bootMac, setBootMac] = useState('');
  const [bootMode, setBootMode] = useState<'UEFI' | 'UEFISecureBoot' | 'legacy'>('UEFI');
  const [rootDeviceHint, setRootDeviceHint] = useState('');
  const [cleaningMode, setCleaningMode] = useState('metadata');

  // Step 3: Network
  const [networkMode, setNetworkMode] = useState<'dhcp' | 'static'>('dhcp');
  const [nmstateYaml, setNmstateYaml] = useState('');

  // Step 4: Registration
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerSuccess, setRegisterSuccess] = useState(false);

  const handleDiscover = useCallback(async () => {
    setDiscovering(true);
    setDiscoveryError(null);
    setDiscoveredInfo(null);
    dashboardLogger.info('REGISTER', 'Starting BMC discovery', `bmc: ${bmcAddress}`);

    try {
      const response = await fetch(`${DISCOVERY_SERVICE_URL}/api/v1/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bmcAddress,
          username: bmcUsername,
          password: bmcPassword,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Discovery failed (${response.status}): ${body}`);
      }

      const data: DiscoveredSystemInfo = await response.json();
      setDiscoveredInfo(data);
      dashboardLogger.info('REGISTER', 'BMC discovery completed', `model: ${data.model}, manufacturer: ${data.manufacturer}`);

      setBmcFullAddress(data.bmcAddress || '');
      setHostName(data.suggestedName || '');
      setBootMac(data.suggestedBootMac || '');
      setBootMode(data.bootMode || 'UEFI');
      if (data.storage.length > 0) {
        const firstDisk = data.storage[0];
        if (firstDisk.serialNumber) {
          setRootDeviceHint(firstDisk.serialNumber);
        } else {
          setRootDeviceHint(String(firstDisk.sizeGb));
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dashboardLogger.error('REGISTER', 'BMC discovery failed', errMsg);
      setDiscoveryError(errMsg);
    } finally {
      setDiscovering(false);
    }
  }, [bmcAddress, bmcUsername, bmcPassword]);

  const handleNmstateChange = useCallback((yaml: string) => {
    setNmstateYaml(yaml);
  }, []);

  const discoveredNics = useMemo(
    () => discoveredInfo?.nics || [],
    [discoveredInfo],
  );

  const credentialSecretName = `bmc-credentials-${hostName || 'new-host'}`;
  const nmstateSecretName = `nmstate-${hostName || 'new-host'}`;

  const buildCredentialSecret = useCallback((): Record<string, unknown> => ({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: credentialSecretName,
      namespace,
      labels: {
        'environment.metal3.io': 'baremetal',
        'app.kubernetes.io/managed-by': 'oct-baremetal',
      },
    },
    type: 'Opaque',
    data: {
      username: btoa(bmcUsername),
      password: btoa(bmcPassword),
    },
  }), [credentialSecretName, namespace, bmcUsername, bmcPassword]);

  const buildNmstateSecret = useCallback((): Record<string, unknown> => ({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: nmstateSecretName,
      namespace,
      labels: {
        'environment.metal3.io': 'baremetal',
        'app.kubernetes.io/managed-by': 'oct-baremetal',
      },
    },
    type: 'Opaque',
    data: {
      nmstate: btoa(nmstateYaml),
    },
  }), [nmstateSecretName, namespace, nmstateYaml]);

  const buildBmhResource = useCallback((): Record<string, unknown> => {
    let rootDeviceHints: Record<string, unknown> | undefined;
    if (rootDeviceHint) {
      const selectedDisk = discoveredInfo?.storage.find(
        (d) => d.serialNumber === rootDeviceHint || String(d.sizeGb) === rootDeviceHint,
      );
      if (selectedDisk?.serialNumber) {
        rootDeviceHints = { serialNumber: selectedDisk.serialNumber };
      } else if (selectedDisk) {
        rootDeviceHints = { minSizeGigabytes: selectedDisk.sizeGb };
      } else {
        rootDeviceHints = { serialNumber: rootDeviceHint };
      }
    }

    const bmh: Record<string, unknown> = {
      apiVersion: 'metal3.io/v1alpha1',
      kind: 'BareMetalHost',
      metadata: {
        name: hostName,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'oct-baremetal',
        },
      },
      spec: {
        bmc: {
          address: bmcFullAddress,
          credentialsName: credentialSecretName,
          disableCertificateVerification: true,
        },
        bootMACAddress: bootMac,
        bootMode,
        online: true,
        automatedCleaningMode: cleaningMode,
        ...(rootDeviceHints ? { rootDeviceHints } : {}),
        ...(networkMode === 'static' ? {
          preprovisioningNetworkDataName: nmstateSecretName,
        } : {}),
      },
    };
    return bmh;
  }, [
    hostName, namespace, bmcFullAddress, credentialSecretName, bootMac,
    bootMode, cleaningMode, rootDeviceHint, discoveredInfo, networkMode, nmstateSecretName,
  ]);

  const handleRegister = useCallback(async () => {
    setRegistering(true);
    setRegisterError(null);
    dashboardLogger.info('REGISTER', 'Registering new BMH', `name: ${hostName}, namespace: ${namespace}`);

    try {
      dashboardLogger.info('REGISTER', 'Creating credential secret', `name: ${credentialSecretName}, namespace: ${namespace}`);
      await k8sCreate({
        model: SecretModel,
        ns: namespace,
        data: buildCredentialSecret() as K8sResourceCommon,
      });
      dashboardLogger.info('REGISTER', 'Credential secret created', credentialSecretName);

      if (networkMode === 'static') {
        dashboardLogger.info('REGISTER', 'Creating NMState secret', `name: ${nmstateSecretName}, namespace: ${namespace}`);
        await k8sCreate({
          model: SecretModel,
          ns: namespace,
          data: buildNmstateSecret() as K8sResourceCommon,
        });
        dashboardLogger.info('REGISTER', 'NMState secret created', nmstateSecretName);
      }

      dashboardLogger.info('REGISTER', 'Creating BareMetalHost', `name: ${hostName}, namespace: ${namespace}`);
      await k8sCreate({
        model: BareMetalHostModel,
        ns: namespace,
        data: buildBmhResource() as K8sResourceCommon,
      });

      dashboardLogger.info('REGISTER', 'BMH registered successfully', `name: ${hostName}`);
      setRegisterSuccess(true);
      setTimeout(() => {
        window.location.href = '/baremetal/nodes';
      }, 2500);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errJson = JSON.stringify(err, Object.getOwnPropertyNames(err));
      dashboardLogger.error('REGISTER', 'BMH registration failed', `${errMsg} | full: ${errJson}`);
      setRegisterError(errMsg);
    } finally {
      setRegistering(false);
    }
  }, [buildCredentialSecret, buildNmstateSecret, buildBmhResource, networkMode, hostName, namespace]);

  const handleCancel = () => {
    window.location.href = '/baremetal/nodes';
  };

  const bmhPreviewYaml = toYaml(buildBmhResource() as Record<string, unknown>);
  const credSecretPreviewYaml = toYaml({
    ...buildCredentialSecret(),
    data: { username: '***', password: '***' },
  } as Record<string, unknown>);

  return (
    <>
      <DocumentTitle>{t('Register BareMetalHost')}</DocumentTitle>

      <PageSection type="breadcrumb">
        <Breadcrumb>
          <BreadcrumbItem
            component="a"
            onClick={(e) => { e.preventDefault(); handleCancel(); }}
          >
            {t('Baremetal Nodes')}
          </BreadcrumbItem>
          <BreadcrumbItem isActive>
            {t('Register Host')}
          </BreadcrumbItem>
        </Breadcrumb>
      </PageSection>

      <ListPageHeader title={t('Register BareMetalHost')} />

      <PageSection>
        <Wizard onClose={handleCancel}>
          {/* Step 1: BMC Connection */}
          <WizardStep name={t('BMC Connection')} id="step-bmc">
            <Stack hasGutter>
              <StackItem>
                <Title headingLevel="h3">{t('BMC Connection Details')}</Title>
                <HelperText>
                  <HelperTextItem>
                    {t('Enter the BMC IP address and credentials to discover the system hardware.')}
                  </HelperTextItem>
                </HelperText>
              </StackItem>

              <StackItem>
                <Form>
                  <FormGroup label={t('BMC IP Address')} fieldId="bmc-address" isRequired>
                    <TextInput
                      id="bmc-address"
                      value={bmcAddress}
                      onChange={(_event, value) => setBmcAddress(value)}
                      placeholder="172.20.254.184"
                    />
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>
                          {t('IP address of the BMC (e.g. 172.20.254.184)')}
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>

                  <FormGroup label={t('Username')} fieldId="bmc-username" isRequired>
                    <TextInput
                      id="bmc-username"
                      value={bmcUsername}
                      onChange={(_event, value) => setBmcUsername(value)}
                      placeholder="admin"
                    />
                  </FormGroup>

                  <FormGroup label={t('Password')} fieldId="bmc-password" isRequired>
                    <TextInput
                      id="bmc-password"
                      type="password"
                      value={bmcPassword}
                      onChange={(_event, value) => setBmcPassword(value)}
                    />
                  </FormGroup>

                  <ActionGroup>
                    <Button
                      variant="secondary"
                      onClick={handleDiscover}
                      isDisabled={discovering || !bmcAddress || !bmcUsername || !bmcPassword}
                      isLoading={discovering}
                      icon={discovering ? undefined : <ServerIcon />}
                    >
                      {discovering ? t('Discovering...') : t('Discover')}
                    </Button>
                  </ActionGroup>
                </Form>
              </StackItem>

              {discoveryError && (
                <StackItem>
                  <Alert variant="danger" title={t('Discovery failed')} isInline>
                    {discoveryError}
                  </Alert>
                </StackItem>
              )}

              {discoveredInfo && (
                <StackItem>
                  <Card>
                    <CardTitle>
                      <Split hasGutter>
                        <SplitItem>
                          <Label color="green" icon={<CheckCircleIcon />} isCompact>
                            {t('Discovered')}
                          </Label>
                        </SplitItem>
                        <SplitItem>
                          <Title headingLevel="h4">{t('System Discovered')}</Title>
                        </SplitItem>
                      </Split>
                    </CardTitle>
                    <CardBody>
                      <DescriptionList isHorizontal columnModifier={{ default: '2Col' }}>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('Manufacturer')}</DescriptionListTerm>
                          <DescriptionListDescription>{discoveredInfo.manufacturer}</DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('Model')}</DescriptionListTerm>
                          <DescriptionListDescription>{discoveredInfo.model}</DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('Serial Number')}</DescriptionListTerm>
                          <DescriptionListDescription>{discoveredInfo.serialNumber}</DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('CPU')}</DescriptionListTerm>
                          <DescriptionListDescription>
                            {discoveredInfo.cpuModel} ({discoveredInfo.cpuCores} {t('cores')})
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('RAM')}</DescriptionListTerm>
                          <DescriptionListDescription>{discoveredInfo.ramGb} GB</DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('NICs')}</DescriptionListTerm>
                          <DescriptionListDescription>
                            {discoveredInfo.nics.map((nic) => (
                              <div key={nic.id}>
                                {nic.name} — <code>{nic.macAddress}</code>{' '}
                                <Label isCompact color={nic.linkState === 'Up' ? 'green' : 'grey'}>
                                  {nic.linkState}
                                </Label>{' '}
                                {nic.speedMbps} Mbps
                              </div>
                            ))}
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('Storage')}</DescriptionListTerm>
                          <DescriptionListDescription>
                            {discoveredInfo.storage.map((disk) => (
                              <div key={disk.name}>
                                {disk.name} — {disk.sizeGb} GB ({disk.type}) — {disk.model}
                              </div>
                            ))}
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                      </DescriptionList>
                    </CardBody>
                  </Card>
                </StackItem>
              )}
            </Stack>
          </WizardStep>

          {/* Step 2: Host Configuration */}
          <WizardStep name={t('Host Configuration')} id="step-config" isDisabled={!discoveredInfo}>
            <Stack hasGutter>
              <StackItem>
                <Title headingLevel="h3">{t('Host Configuration')}</Title>
                <HelperText>
                  <HelperTextItem>
                    {t('Configure the host name, boot settings, and cleaning mode.')}
                  </HelperTextItem>
                </HelperText>
              </StackItem>

              <StackItem>
                <Form>
                  <FormGroup label={t('Host Name')} fieldId="host-name" isRequired>
                    <TextInput
                      id="host-name"
                      value={hostName}
                      onChange={(_event, value) => setHostName(value)}
                      placeholder="r640-abc123"
                    />
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>
                          {t('Name for the BareMetalHost resource. Must be a valid Kubernetes name.')}
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>

                  <FormGroup label={t('Namespace')} fieldId="namespace" isRequired>
                    <TextInput
                      id="namespace"
                      value={namespace}
                      onChange={(_event, value) => setNamespace(value)}
                    />
                  </FormGroup>

                  <FormGroup label={t('BMC Address')} fieldId="bmc-full-address" isRequired>
                    <TextInput
                      id="bmc-full-address"
                      value={bmcFullAddress}
                      onChange={(_event, value) => setBmcFullAddress(value)}
                    />
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>
                          {t('Auto-detected from discovery. Override if needed.')}
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>

                  <FormGroup label={t('Boot MAC Address')} fieldId="boot-mac" isRequired>
                    {discoveredNics.length > 0 ? (
                      <FormSelect
                        id="boot-mac"
                        value={bootMac}
                        onChange={(_event, value) => setBootMac(value)}
                      >
                        {discoveredNics.map((nic) => (
                          <FormSelectOption
                            key={nic.id}
                            value={nic.macAddress}
                            label={`${nic.name} — ${nic.macAddress} (${nic.linkState}, ${nic.speedMbps} Mbps)`}
                          />
                        ))}
                      </FormSelect>
                    ) : (
                      <TextInput
                        id="boot-mac"
                        value={bootMac}
                        onChange={(_event, value) => setBootMac(value)}
                        placeholder="AA:BB:CC:DD:EE:FF"
                      />
                    )}
                  </FormGroup>

                  <FormGroup label={t('Boot Mode')} fieldId="boot-mode" isRequired>
                    <FormSelect
                      id="boot-mode"
                      value={bootMode}
                      onChange={(_event, value) => setBootMode(value as 'UEFI' | 'UEFISecureBoot' | 'legacy')}
                    >
                      <FormSelectOption value="UEFI" label="UEFI" />
                      <FormSelectOption value="UEFISecureBoot" label="UEFI Secure Boot" />
                      <FormSelectOption value="legacy" label="Legacy" />
                    </FormSelect>
                  </FormGroup>

                  <FormGroup label={t('Root Device Hint')} fieldId="root-device">
                    {discoveredInfo && discoveredInfo.storage.length > 0 ? (
                      <FormSelect
                        id="root-device"
                        value={rootDeviceHint}
                        onChange={(_event, value) => setRootDeviceHint(value)}
                      >
                        <FormSelectOption value="" label={t('-- None --')} />
                        {discoveredInfo.storage.map((disk) => {
                          const value = disk.serialNumber || String(disk.sizeGb);
                          const snLabel = disk.serialNumber ? `, S/N: ${disk.serialNumber}` : '';
                          const protoLabel = disk.protocol ? `, ${disk.protocol}` : '';
                          const label = `${disk.name} (${disk.sizeGb} GB${protoLabel}${snLabel})`;
                          return (
                            <FormSelectOption
                              key={value}
                              value={value}
                              label={label}
                            />
                          );
                        })}
                      </FormSelect>
                    ) : (
                      <TextInput
                        id="root-device"
                        value={rootDeviceHint}
                        onChange={(_event, value) => setRootDeviceHint(value)}
                        placeholder="/dev/sda"
                      />
                    )}
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>
                          {t('Serial number hint for the root disk. Falls back to minimum size if unavailable.')}
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>

                  <FormGroup label={t('Automated Cleaning Mode')} fieldId="cleaning-mode">
                    <FormSelect
                      id="cleaning-mode"
                      value={cleaningMode}
                      onChange={(_event, value) => setCleaningMode(value)}
                    >
                      <FormSelectOption value="metadata" label={t('Metadata')} />
                      <FormSelectOption value="disabled" label={t('Disabled')} />
                    </FormSelect>
                  </FormGroup>
                </Form>
              </StackItem>
            </Stack>
          </WizardStep>

          {/* Step 3: Network Configuration */}
          <WizardStep name={t('Network Configuration')} id="step-network" isDisabled={!discoveredInfo}>
            <Stack hasGutter>
              <StackItem>
                <Title headingLevel="h3">{t('Network Configuration')}</Title>
              </StackItem>

              <StackItem>
                <FormGroup label={t('Network Mode')} fieldId="network-mode" role="radiogroup">
                  <Radio
                    id="net-dhcp"
                    name="network-mode"
                    label={t('Use DHCP')}
                    isChecked={networkMode === 'dhcp'}
                    onChange={() => setNetworkMode('dhcp')}
                    description={t('The host will obtain network configuration automatically via DHCP.')}
                  />
                  <Radio
                    id="net-static"
                    name="network-mode"
                    label={t('Configure Static Networking')}
                    isChecked={networkMode === 'static'}
                    onChange={() => setNetworkMode('static')}
                    description={t('Provide static network configuration using NMState.')}
                  />
                </FormGroup>
              </StackItem>

              {networkMode === 'static' && (
                <StackItem>
                  <NMStateBuilder
                    discoveredNics={discoveredNics}
                    onChange={handleNmstateChange}
                  />
                </StackItem>
              )}
            </Stack>
          </WizardStep>

          {/* Step 4: Review & Register */}
          <WizardStep
            name={t('Review & Register')}
            id="step-review"
            isDisabled={!discoveredInfo}
            footer={{
              nextButtonText: registering ? t('Registering...') : t('Register'),
              onNext: handleRegister,
              isNextDisabled: registering || registerSuccess || !hostName || !bootMac || !bmcFullAddress,
            }}
          >
            <Stack hasGutter>
              <StackItem>
                <Title headingLevel="h3">{t('Review & Register')}</Title>
                <HelperText>
                  <HelperTextItem>
                    {t('Review the configuration below and click Register to create the resources.')}
                  </HelperTextItem>
                </HelperText>
              </StackItem>

              {registerError && (
                <StackItem>
                  <Alert variant="danger" title={t('Registration failed')} isInline>
                    {registerError}
                  </Alert>
                </StackItem>
              )}

              {registerSuccess && (
                <StackItem>
                  <Alert variant="success" title={t('Host registered successfully')} isInline>
                    {t('BareMetalHost')} <strong>{hostName}</strong> {t('has been created in namespace')} <strong>{namespace}</strong>.{' '}
                    {t('Redirecting to inventory...')}
                  </Alert>
                </StackItem>
              )}

              {registering && (
                <StackItem>
                  <Bullseye><Spinner size="lg" /></Bullseye>
                </StackItem>
              )}

              <StackItem>
                <Card>
                  <CardTitle>
                    <Split hasGutter>
                      <SplitItem><ServerIcon /></SplitItem>
                      <SplitItem><Title headingLevel="h4">{t('Configuration Summary')}</Title></SplitItem>
                    </Split>
                  </CardTitle>
                  <CardBody>
                    <DescriptionList isHorizontal>
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Host Name')}</DescriptionListTerm>
                        <DescriptionListDescription>{hostName || '—'}</DescriptionListDescription>
                      </DescriptionListGroup>
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Namespace')}</DescriptionListTerm>
                        <DescriptionListDescription>{namespace}</DescriptionListDescription>
                      </DescriptionListGroup>
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('BMC Address')}</DescriptionListTerm>
                        <DescriptionListDescription><code>{bmcFullAddress || '—'}</code></DescriptionListDescription>
                      </DescriptionListGroup>
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Boot MAC')}</DescriptionListTerm>
                        <DescriptionListDescription><code>{bootMac || '—'}</code></DescriptionListDescription>
                      </DescriptionListGroup>
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Boot Mode')}</DescriptionListTerm>
                        <DescriptionListDescription>{bootMode}</DescriptionListDescription>
                      </DescriptionListGroup>
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Root Device')}</DescriptionListTerm>
                        <DescriptionListDescription>{rootDeviceHint || t('Not specified')}</DescriptionListDescription>
                      </DescriptionListGroup>
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Cleaning Mode')}</DescriptionListTerm>
                        <DescriptionListDescription>{cleaningMode}</DescriptionListDescription>
                      </DescriptionListGroup>
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Network')}</DescriptionListTerm>
                        <DescriptionListDescription>
                          <Label isCompact color={networkMode === 'static' ? 'blue' : 'green'}>
                            {networkMode === 'static' ? t('Static (NMState)') : t('DHCP')}
                          </Label>
                        </DescriptionListDescription>
                      </DescriptionListGroup>
                    </DescriptionList>
                  </CardBody>
                </Card>
              </StackItem>

              <StackItem>
                <Divider />
              </StackItem>

              <StackItem>
                <Title headingLevel="h4">{t('Resources to be created')}</Title>
              </StackItem>

              <StackItem>
                <Card>
                  <CardTitle>{t('BMC Credentials Secret')}</CardTitle>
                  <CardBody>
                    <CodeBlock>
                      <CodeBlockCode>{credSecretPreviewYaml}</CodeBlockCode>
                    </CodeBlock>
                  </CardBody>
                </Card>
              </StackItem>

              {networkMode === 'static' && (
                <StackItem>
                  <Card>
                    <CardTitle>{t('NMState Network Secret')}</CardTitle>
                    <CardBody>
                      <CodeBlock>
                        <CodeBlockCode>{nmstateYaml}</CodeBlockCode>
                      </CodeBlock>
                    </CardBody>
                  </Card>
                </StackItem>
              )}

              <StackItem>
                <Card>
                  <CardTitle>{t('BareMetalHost')}</CardTitle>
                  <CardBody>
                    <CodeBlock>
                      <CodeBlockCode>{bmhPreviewYaml}</CodeBlockCode>
                    </CodeBlock>
                  </CardBody>
                </Card>
              </StackItem>
            </Stack>
          </WizardStep>
        </Wizard>
      </PageSection>
    </>
  );
};

export default RegisterWizardPage;
