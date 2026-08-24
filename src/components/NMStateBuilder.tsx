import React, { useState, useEffect, useCallback, FC } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FormGroup,
  Form,
  TextInput,
  FormSelect,
  FormSelectOption,
  Radio,
  Card,
  CardBody,
  CardTitle,
  Stack,
  StackItem,
  Title,
  Label,
  Checkbox,
  CodeBlock,
  CodeBlockCode,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Divider,
} from '@patternfly/react-core';
import { Table, Thead, Tr, Th, Tbody, Td } from '@patternfly/react-table';
import { toYaml } from '../utils/yaml';

function formatSpeed(mbps: number): string {
  if (mbps >= 1000) return `${mbps / 1000} Gbps`;
  return `${mbps} Mbps`;
}

export interface DiscoveredNic {
  id: string;
  name: string;
  macAddress: string;
  speedMbps: number;
  linkState: 'Up' | 'Down' | 'Unknown';
}

export interface NMStateBuilderProps {
  discoveredNics: DiscoveredNic[];
  onChange: (nmstateYaml: string) => void;
  initialConfig?: string;
}

type NicMode = 'single' | 'bond';
type BondMode = '802.3ad' | 'active-backup' | 'balance-rr';

interface NmstateConfig {
  'dns-resolver'?: {
    config: {
      server: string[];
    };
  };
  interfaces: Array<Record<string, unknown>>;
  routes?: {
    config: Array<Record<string, unknown>>;
  };
}

const NMStateBuilder: FC<NMStateBuilderProps> = ({ discoveredNics, onChange }) => {
  const { t } = useTranslation('plugin__oct-baremetal');

  const [nicMode, setNicMode] = useState<NicMode>('single');
  const [selectedNic, setSelectedNic] = useState('');
  const [selectedBondNics, setSelectedBondNics] = useState<string[]>([]);
  const [bondMode, setBondMode] = useState<BondMode>('802.3ad');
  const [bondName, setBondName] = useState('bond0');
  const [ipAddress, setIpAddress] = useState('');
  const [prefixLength, setPrefixLength] = useState('24');
  const [gateway, setGateway] = useState('');
  const [dnsServers, setDnsServers] = useState('');
  const [vlanId, setVlanId] = useState('');

  useEffect(() => {
    if (discoveredNics.length > 0 && !selectedNic) {
      setSelectedNic(discoveredNics[0].name);
    }
  }, [discoveredNics, selectedNic]);

  const buildNmstateConfig = useCallback((): NmstateConfig => {
    const dnsServerList = dnsServers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const config: NmstateConfig = {
      interfaces: [],
    };

    if (dnsServerList.length > 0) {
      config['dns-resolver'] = {
        config: { server: dnsServerList },
      };
    }

    const prefixNum = parseInt(prefixLength, 10) || 24;
    const ipEnabled = Boolean(ipAddress);

    const findNicMac = (nicName: string): string | undefined => {
      const nic = discoveredNics.find((n) => n.name === nicName);
      return nic?.macAddress;
    };

    if (nicMode === 'single') {
      const nicMac = findNicMac(selectedNic);
      const portName = selectedNic || 'eno1';
      const actualIfaceName = vlanId ? `${portName}.${vlanId}` : portName;

      const ethIface: Record<string, unknown> = {
        name: portName,
        type: 'ethernet',
        state: 'up',
      };
      if (nicMac) {
        ethIface.identifier = 'mac-address';
        ethIface['mac-address'] = nicMac;
      }

      if (vlanId) {
        ethIface.ipv4 = { dhcp: false, enabled: false };
        ethIface.ipv6 = { enabled: false };
        config.interfaces.push(ethIface);

        config.interfaces.push({
          name: actualIfaceName,
          type: 'vlan',
          state: 'up',
          vlan: { 'base-iface': portName, id: parseInt(vlanId, 10) },
          ipv4: ipEnabled
            ? {
                address: [{ ip: ipAddress, 'prefix-length': prefixNum }],
                dhcp: false,
                enabled: true,
              }
            : { dhcp: false, enabled: false },
          ipv6: { enabled: false },
        });
      } else {
        ethIface.ipv4 = ipEnabled
          ? {
              address: [{ ip: ipAddress, 'prefix-length': prefixNum }],
              dhcp: false,
              enabled: true,
            }
          : { dhcp: false, enabled: false };
        ethIface.ipv6 = { enabled: false };
        config.interfaces.push(ethIface);
      }

      if (gateway && ipEnabled) {
        config.routes = {
          config: [
            {
              destination: '0.0.0.0/0',
              'next-hop-address': gateway,
              'next-hop-interface': actualIfaceName,
              'table-id': 254,
            },
          ],
        };
      }
    } else {
      const ipInterface = vlanId ? `${bondName}.${vlanId}` : bondName;

      const portNames: string[] = [];
      selectedBondNics.forEach((nicName, idx) => {
        const nicMac = findNicMac(nicName);
        const portLabel = `${bondName}-port${idx}`;
        portNames.push(portLabel);

        const ethIface: Record<string, unknown> = {
          name: portLabel,
          type: 'ethernet',
          state: 'up',
          ipv4: { dhcp: false, enabled: false },
          ipv6: { enabled: false },
        };
        if (nicMac) {
          ethIface.identifier = 'mac-address';
          ethIface['mac-address'] = nicMac;
        }
        config.interfaces.push(ethIface);
      });

      config.interfaces.push({
        name: bondName,
        type: 'bond',
        state: 'up',
        ipv4: vlanId ? { dhcp: false, enabled: false } : ipEnabled
          ? {
              address: [{ ip: ipAddress, 'prefix-length': prefixNum }],
              dhcp: false,
              enabled: true,
            }
          : { dhcp: false, enabled: false },
        ipv6: { enabled: false },
        'link-aggregation': {
          mode: bondMode,
          options: { miimon: '100' },
          port: portNames,
        },
      });

      if (vlanId) {
        config.interfaces.push({
          name: ipInterface,
          type: 'vlan',
          state: 'up',
          vlan: { 'base-iface': bondName, id: parseInt(vlanId, 10) },
          ipv4: ipEnabled
            ? {
                address: [{ ip: ipAddress, 'prefix-length': prefixNum }],
                dhcp: false,
                enabled: true,
              }
            : { dhcp: false, enabled: false },
          ipv6: { enabled: false },
        });
      }

      if (gateway && ipEnabled) {
        config.routes = {
          config: [
            {
              destination: '0.0.0.0/0',
              'next-hop-address': gateway,
              'next-hop-interface': ipInterface,
              'table-id': 254,
            },
          ],
        };
      }
    }

    return config;
  }, [
    nicMode, selectedNic, selectedBondNics, bondMode, bondName,
    ipAddress, prefixLength, gateway, dnsServers, vlanId, discoveredNics,
  ]);

  useEffect(() => {
    const config = buildNmstateConfig();
    const yaml = toYaml(config as unknown as Record<string, unknown>);
    onChange(yaml);
  }, [buildNmstateConfig, onChange]);

  const handleBondNicToggle = (nicName: string, checked: boolean) => {
    setSelectedBondNics((prev) =>
      checked ? [...prev, nicName] : prev.filter((n) => n !== nicName),
    );
  };

  const getNicLabel = (nic: DiscoveredNic): string =>
    `${nic.name} (${nic.macAddress}) — ${nic.speedMbps} Mbps — ${nic.linkState}`;

  const previewYaml = toYaml(buildNmstateConfig() as unknown as Record<string, unknown>);

  return (
    <Stack hasGutter>
      <StackItem>
        <FormGroup label={t('NIC Mode')} fieldId="nic-mode" role="radiogroup">
          <Radio
            id="nic-mode-single"
            name="nic-mode"
            label={t('Single NIC')}
            isChecked={nicMode === 'single'}
            onChange={() => setNicMode('single')}
          />
          <Radio
            id="nic-mode-bond"
            name="nic-mode"
            label={t('Bonded NICs')}
            isChecked={nicMode === 'bond'}
            onChange={() => setNicMode('bond')}
          />
        </FormGroup>
      </StackItem>

      <StackItem>
        <Form>
          {nicMode === 'single' ? (
            <FormGroup label={t('Network Interface')} fieldId="select-nic" isRequired>
              <FormSelect
                id="select-nic"
                value={selectedNic}
                onChange={(_event, value) => setSelectedNic(value)}
              >
                {discoveredNics.map((nic) => (
                  <FormSelectOption
                    key={nic.id}
                    value={nic.name}
                    label={getNicLabel(nic)}
                  />
                ))}
              </FormSelect>
            </FormGroup>
          ) : (
            <>
              <FormGroup label={t('Bond Name')} fieldId="bond-name">
                <TextInput
                  id="bond-name"
                  value={bondName}
                  onChange={(_event, value) => setBondName(value)}
                />
              </FormGroup>

              <FormGroup label={t('Bond Mode')} fieldId="bond-mode">
                <FormSelect
                  id="bond-mode"
                  value={bondMode}
                  onChange={(_event, value) => setBondMode(value as BondMode)}
                >
                  <FormSelectOption value="802.3ad" label="802.3ad (LACP)" />
                  <FormSelectOption value="active-backup" label={t('Active-Backup')} />
                  <FormSelectOption value="balance-rr" label={t('Balance Round-Robin')} />
                </FormSelect>
              </FormGroup>

              <FormGroup label={t('Select NICs to Bond')} fieldId="bond-nics">
                <Table aria-label={t('Select NICs to Bond')} variant="compact">
                  <Thead>
                    <Tr>
                      <Th screenReaderText={t('Select')} />
                      <Th>{t('NIC ID')}</Th>
                      <Th>{t('MAC Address')}</Th>
                      <Th>{t('Link State')}</Th>
                      <Th>{t('Speed')}</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {discoveredNics.map((nic) => (
                      <Tr key={nic.id}>
                        <Td>
                          <Checkbox
                            id={`bond-nic-${nic.id}`}
                            isChecked={selectedBondNics.includes(nic.name)}
                            onChange={(checked) => handleBondNicToggle(nic.name, Boolean(checked))}
                            aria-label={`${t('Select')} ${nic.name}`}
                          />
                        </Td>
                        <Td dataLabel={t('NIC ID')}>{nic.name}</Td>
                        <Td dataLabel={t('MAC Address')}><code>{nic.macAddress}</code></Td>
                        <Td dataLabel={t('Link State')}>
                          <Label isCompact color={nic.linkState === 'Up' ? 'green' : 'grey'}>
                            {nic.linkState}
                          </Label>
                        </Td>
                        <Td dataLabel={t('Speed')}>{formatSpeed(nic.speedMbps)}</Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem>
                      {t('Select at least 2 NICs for bonding')}
                    </HelperTextItem>
                  </HelperText>
                </FormHelperText>
              </FormGroup>
            </>
          )}

          <Divider />

          <FormGroup label={t('IP Address')} fieldId="ip-address" isRequired>
            <TextInput
              id="ip-address"
              value={ipAddress}
              onChange={(_event, value) => setIpAddress(value)}
              placeholder="192.168.1.100"
            />
          </FormGroup>

          <FormGroup label={t('Prefix Length')} fieldId="prefix-length" isRequired>
            <TextInput
              id="prefix-length"
              value={prefixLength}
              onChange={(_event, value) => setPrefixLength(value)}
              placeholder="24"
              type="number"
            />
          </FormGroup>

          <FormGroup label={t('Gateway')} fieldId="gateway" isRequired>
            <TextInput
              id="gateway"
              value={gateway}
              onChange={(_event, value) => setGateway(value)}
              placeholder="192.168.1.1"
            />
          </FormGroup>

          <FormGroup label={t('DNS Servers')} fieldId="dns-servers">
            <TextInput
              id="dns-servers"
              value={dnsServers}
              onChange={(_event, value) => setDnsServers(value)}
              placeholder="8.8.8.8, 8.8.4.4"
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>{t('Comma-separated list of DNS servers')}</HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup label={t('VLAN ID (optional)')} fieldId="vlan-id">
            <TextInput
              id="vlan-id"
              value={vlanId}
              onChange={(_event, value) => setVlanId(value)}
              placeholder="2117"
              type="number"
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>{t('Leave empty if no VLAN tagging is needed')}</HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>
        </Form>
      </StackItem>

      <StackItem>
        <Card>
          <CardTitle>
            <Title headingLevel="h4">{t('NMState YAML Preview')}</Title>
          </CardTitle>
          <CardBody>
            <CodeBlock>
              <CodeBlockCode>{previewYaml}</CodeBlockCode>
            </CodeBlock>
          </CardBody>
        </Card>
      </StackItem>
    </Stack>
  );
};

export default NMStateBuilder;
