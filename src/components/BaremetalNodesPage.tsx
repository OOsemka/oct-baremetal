import {
  K8sResourceCommon,
  ListPageHeader,
  useK8sWatchResource,
  DocumentTitle,
  k8sPatch,
  k8sDelete,
  k8sGet,
} from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import {
  PageSection,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToolbarFilter,
  ToolbarGroup,
  SearchInput,
  EmptyState,
  EmptyStateBody,
  Spinner,
  Alert,
  Bullseye,
  Button,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Select,
  SelectOption,
  SelectList,
  MenuToggle,
  MenuToggleElement,
} from '@patternfly/react-core';
import {
  Table,
  Thead,
  Tr,
  Th,
  Tbody,
  Td,
  ActionsColumn,
  IAction,
} from '@patternfly/react-table';
import {
  ServerIcon,
  PowerOffIcon,
  OnRunningIcon,
  FilterIcon,
  CheckCircleIcon,
  InProgressIcon,
  ExclamationCircleIcon,
  UnknownIcon,
} from '@patternfly/react-icons';
import React, { useState, useMemo, useCallback, useEffect, FC } from 'react';

import {
  BareMetalHostModel,
  BareMetalHostKind,
  NodeModel,
  NodeKind,
  NodeNetworkStateModel,
  NodeNetworkStateKind,
  SecretModel,
  getProvisioningState,
  isPoweredOn,
  getHardwareSummary,
  getSystemVendorInfo,
  isAvailableForProvisioning,
  isProvisioned,
} from '../utils/k8s-resources';
import {
  RoutableIp,
  decodeNmstateSecretData,
  networkDataRefKey,
  resolveBareMetalHostRoutableIp,
} from '../utils/routable-ip';

import dashboardLogger from '../utils/logger';
import CommunityDisclaimer from './CommunityDisclaimer';

import './baremetal-nodes.css';

const STATUS_ICON_CONFIG: Record<string, { colorClass: string; icon: React.ReactElement }> = {
  available: { colorClass: 'bmh-status--success', icon: <CheckCircleIcon /> },
  ready: { colorClass: 'bmh-status--success', icon: <CheckCircleIcon /> },
  provisioned: { colorClass: 'bmh-status--success', icon: <CheckCircleIcon /> },
  provisioning: { colorClass: 'bmh-status--info', icon: <InProgressIcon /> },
  inspecting: { colorClass: 'bmh-status--info', icon: <InProgressIcon /> },
  registering: { colorClass: 'bmh-status--info', icon: <InProgressIcon /> },
  deprovisioning: { colorClass: 'bmh-status--info', icon: <InProgressIcon /> },
  error: { colorClass: 'bmh-status--danger', icon: <ExclamationCircleIcon /> },
  unknown: { colorClass: 'bmh-status--unknown', icon: <UnknownIcon /> },
  externally_provisioned: { colorClass: 'bmh-status--success', icon: <CheckCircleIcon /> },
};

type FilterCategory = 'name' | 'status' | 'bmc-address';

const FILTER_OPTIONS: { value: FilterCategory; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'status', label: 'Status' },
  { value: 'bmc-address', label: 'BMC Address' },
];

const HostIpCell: FC<{ info: RoutableIp | null }> = ({ info }) => {
  const { t } = useTranslation('plugin__oct-baremetal');
  if (!info) {
    return <span className="bmh-host-ip-empty">—</span>;
  }
  const isFallback = info.source === 'node-internal-ip';
  const title = isFallback
    ? t('Node InternalIP (not confirmed as the default-route address)')
    : info.interface
      ? t('Default route on {{interface}}', { interface: info.interface })
      : t('Default-route address');
  return (
    <span
      className={isFallback ? 'bmh-host-ip bmh-host-ip--fallback' : 'bmh-host-ip'}
      title={title}
    >
      {info.ip}
    </span>
  );
};

const BaremetalNodesPage: FC = () => {
  const { t } = useTranslation('plugin__oct-baremetal');

  const [selectedNamespace, setSelectedNamespace] = useState<string>('all');
  const [isNamespaceOpen, setIsNamespaceOpen] = useState(false);

  const [filterCategory, setFilterCategory] = useState<FilterCategory>('name');
  const [isFilterCatOpen, setIsFilterCatOpen] = useState(false);
  const [filterValue, setFilterValue] = useState('');
  const [activeFilters, setActiveFilters] = useState<Record<FilterCategory, string[]>>({
    name: [],
    status: [],
    'bmc-address': [],
  });

  const [actionModal, setActionModal] = useState<{
    type: 'deprovision' | 'delete';
    bmh: BareMetalHostKind;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState(false);

  const [bmhList, bmhLoaded, bmhError] = useK8sWatchResource<K8sResourceCommon[]>({
    groupVersionKind: {
      group: BareMetalHostModel.apiGroup,
      version: BareMetalHostModel.apiVersion,
      kind: BareMetalHostModel.kind,
    },
    isList: true,
    namespaced: false,
  });

  const [nnsList, nnsLoaded] = useK8sWatchResource<K8sResourceCommon[]>({
    groupVersionKind: {
      group: NodeNetworkStateModel.apiGroup,
      version: NodeNetworkStateModel.apiVersion,
      kind: NodeNetworkStateModel.kind,
    },
    isList: true,
    namespaced: false,
  });

  const [nodeList, nodesLoaded] = useK8sWatchResource<K8sResourceCommon[]>({
    groupVersionKind: {
      group: NodeModel.apiGroup || '',
      version: NodeModel.apiVersion,
      kind: NodeModel.kind,
    },
    isList: true,
    namespaced: false,
  });

  const hosts = useMemo(
    () => (bmhList as BareMetalHostKind[]) || [],
    [bmhList],
  );

  const nodeNetworkStates = useMemo(
    () => ((nnsLoaded && nnsList) ? (nnsList as NodeNetworkStateKind[]) : []),
    [nnsList, nnsLoaded],
  );

  const nodes = useMemo(
    () => ((nodesLoaded && nodeList) ? (nodeList as NodeKind[]) : []),
    [nodeList, nodesLoaded],
  );

  const [networkDataByRef, setNetworkDataByRef] = useState<Record<string, string | null>>({});

  const networkDataRefsKey = useMemo(() => {
    const keys = hosts
      .filter((bmh) => isProvisioned(bmh) && bmh.spec.networkData?.name)
      .map((bmh) =>
        networkDataRefKey(
          bmh.spec.networkData!.namespace || bmh.metadata.namespace,
          bmh.spec.networkData!.name,
        ),
      );
    return Array.from(new Set(keys)).sort().join(',');
  }, [hosts]);

  useEffect(() => {
    if (!networkDataRefsKey) {
      setNetworkDataByRef({});
      return;
    }
    let cancelled = false;
    const refs = networkDataRefsKey.split(',').map((key) => {
      const slash = key.indexOf('/');
      return { key, namespace: key.slice(0, slash), name: key.slice(slash + 1) };
    });
    Promise.all(
      refs.map(async ({ key, namespace, name }) => {
        try {
          const secret = await k8sGet({
            model: SecretModel,
            name,
            ns: namespace,
          }) as K8sResourceCommon & { data?: Record<string, string> };
          return [key, decodeNmstateSecretData(secret?.data)] as const;
        } catch {
          return [key, null] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) {
        setNetworkDataByRef(Object.fromEntries(entries));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [networkDataRefsKey]);

  const ipByHost = useMemo(() => {
    const map = new Map<string, RoutableIp | null>();
    for (const bmh of hosts) {
      const key = bmh.metadata.uid || `${bmh.metadata.namespace}/${bmh.metadata.name}`;
      map.set(
        key,
        resolveBareMetalHostRoutableIp({
          bmh,
          nnsList: nodeNetworkStates,
          nodes,
          networkDataByRef,
          nnsLoaded,
        }),
      );
    }
    return map;
  }, [hosts, nodeNetworkStates, nodes, networkDataByRef, nnsLoaded]);

  const namespaces = useMemo(
    () => Array.from(new Set(hosts.map((bmh) => bmh.metadata.namespace))).sort(),
    [hosts],
  );

  const filteredHosts = useMemo(() => {
    let result = hosts;

    if (selectedNamespace !== 'all') {
      result = result.filter((bmh) => bmh.metadata.namespace === selectedNamespace);
    }

    for (const cat of Object.keys(activeFilters) as FilterCategory[]) {
      const chips = activeFilters[cat];
      if (chips.length === 0) continue;
      result = result.filter((bmh) => {
        const value =
          cat === 'name' ? bmh.metadata.name :
          cat === 'status' ? getProvisioningState(bmh) :
          bmh.spec.bmc?.address || '';
        return chips.some((chip) => value.toLowerCase().includes(chip.toLowerCase()));
      });
    }

    return result;
  }, [hosts, selectedNamespace, activeFilters]);

  useEffect(() => {
    if (bmhLoaded && hosts.length > 0) {
      dashboardLogger.info('LIST', 'BMH inventory loaded', `${hosts.length} hosts found`);
    }
  }, [bmhLoaded, hosts.length]);

  const addFilter = useCallback(() => {
    const val = filterValue.trim();
    if (!val) return;
    setActiveFilters((prev) => {
      if (prev[filterCategory].includes(val)) return prev;
      return { ...prev, [filterCategory]: [...prev[filterCategory], val] };
    });
    setFilterValue('');
  }, [filterCategory, filterValue]);

  const clearAllFilters = useCallback(() => {
    setActiveFilters({ name: [], status: [], 'bmc-address': [] });
  }, []);

  const handleDeprovision = useCallback(async (bmh: BareMetalHostKind) => {
    setActionInProgress(true);
    setActionError(null);
    try {
      for (const field of ['image', 'userData', 'networkData', 'metaData']) {
        try {
          await k8sPatch({
            model: BareMetalHostModel,
            resource: bmh as K8sResourceCommon,
            data: [{ op: 'remove', path: `/spec/${field}` }],
          });
        } catch (_e) {
          // Field may not exist on the BMH spec
        }
      }
      await k8sPatch({
        model: BareMetalHostModel,
        resource: bmh as K8sResourceCommon,
        data: [{ op: 'replace', path: '/spec/online', value: false }],
      });
      dashboardLogger.info('DEPROVISION', 'Host deprovisioned successfully', `host: ${bmh.metadata.name}, namespace: ${bmh.metadata.namespace}`);
      setActionModal(null);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dashboardLogger.error('DEPROVISION', 'Failed to deprovision host', errMsg);
      setActionError(errMsg);
    } finally {
      setActionInProgress(false);
    }
  }, []);

  const handlePowerToggle = useCallback(async (bmh: BareMetalHostKind) => {
    const newState = !isPoweredOn(bmh);
    try {
      await k8sPatch({
        model: BareMetalHostModel,
        resource: bmh as K8sResourceCommon,
        data: [{ op: 'replace', path: '/spec/online', value: newState }],
      });
      dashboardLogger.info('POWER', `Host powered ${newState ? 'on' : 'off'}`, `host: ${bmh.metadata.name}, namespace: ${bmh.metadata.namespace}`);
    } catch (err) {
      console.error('Power toggle failed:', err);
      dashboardLogger.error('POWER', 'Failed to toggle power', err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleDeleteHost = useCallback(async (bmh: BareMetalHostKind) => {
    setActionInProgress(true);
    setActionError(null);
    try {
      await k8sDelete({
        model: BareMetalHostModel,
        resource: bmh as K8sResourceCommon,
      });
      dashboardLogger.info('DELETE', 'Host deleted', `host: ${bmh.metadata.name}, namespace: ${bmh.metadata.namespace}`);
      setActionModal(null);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dashboardLogger.error('DELETE', 'Failed to delete host', errMsg);
      setActionError(errMsg);
    } finally {
      setActionInProgress(false);
    }
  }, []);

  const getRowActions = useCallback(
    (bmh: BareMetalHostKind): IAction[] => {
      const actions: IAction[] = [];

      if (isAvailableForProvisioning(bmh)) {
        actions.push({
          title: t('Deploy'),
          onClick: () => {
            dashboardLogger.info('DEPLOY', 'Navigating to deploy page', `host: ${bmh.metadata.name}, namespace: ${bmh.metadata.namespace}`);
            window.location.href = `/baremetal/nodes/deploy/${bmh.metadata.namespace}/${bmh.metadata.name}`;
          },
        });
      }

      if (isProvisioned(bmh)) {
        actions.push({
          title: t('Deprovision'),
          onClick: () => {
            setActionModal({ type: 'deprovision', bmh });
          },
        });
      }

      actions.push({
        title: isPoweredOn(bmh) ? t('Power Off') : t('Power On'),
        onClick: () => handlePowerToggle(bmh),
      });

      actions.push({ isSeparator: true });

      actions.push({
        title: t('Delete'),
        onClick: () => {
          setActionModal({ type: 'delete', bmh });
        },
      });

      return actions;
    },
    [t, handlePowerToggle],
  );

  if (!bmhLoaded) {
    return (
      <PageSection>
        <Bullseye>
          <Spinner size="xl" />
        </Bullseye>
      </PageSection>
    );
  }

  const filterCategoryLabel = FILTER_OPTIONS.find((o) => o.value === filterCategory)?.label || 'Name';

  return (
    <>
      <DocumentTitle>{t('Bare Metal Hosts')}</DocumentTitle>

      <div className="bmh-namespace-bar">
        <span className="bmh-namespace-label">{t('Project')}</span>
        <Select
          id="namespace-select"
          isOpen={isNamespaceOpen}
          selected={selectedNamespace}
          onSelect={(_event, value) => {
            setSelectedNamespace(value as string);
            setIsNamespaceOpen(false);
          }}
          onOpenChange={setIsNamespaceOpen}
          toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
            <MenuToggle
              ref={toggleRef}
              onClick={() => setIsNamespaceOpen(!isNamespaceOpen)}
              isExpanded={isNamespaceOpen}
            >
              {selectedNamespace === 'all' ? t('All Projects') : selectedNamespace}
            </MenuToggle>
          )}
        >
          <SelectList>
            <SelectOption value="all">{t('All Projects')}</SelectOption>
            {namespaces.map((ns) => (
              <SelectOption key={ns} value={ns}>{ns}</SelectOption>
            ))}
          </SelectList>
        </Select>
      </div>

      <ListPageHeader title={t('Bare Metal Hosts')}>
        <Button
          variant="primary"
          onClick={() => { window.location.href = '/baremetal/nodes/register'; }}
        >
          {t('Register Host')}
        </Button>
      </ListPageHeader>

      <PageSection>
        <CommunityDisclaimer />

        {bmhError && (
          <Alert variant="danger" title={t('Error')} isInline>
            {String(bmhError)}
          </Alert>
        )}

        <Toolbar clearAllFilters={clearAllFilters}>
          <ToolbarContent>
            <ToolbarGroup variant="filter-group">
              <ToolbarItem>
                <Select
                  id="filter-category-select"
                  isOpen={isFilterCatOpen}
                  selected={filterCategory}
                  onSelect={(_event, value) => {
                    setFilterCategory(value as FilterCategory);
                    setFilterValue('');
                    setIsFilterCatOpen(false);
                  }}
                  onOpenChange={setIsFilterCatOpen}
                  toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                    <MenuToggle
                      ref={toggleRef}
                      onClick={() => setIsFilterCatOpen(!isFilterCatOpen)}
                      isExpanded={isFilterCatOpen}
                    >
                      <FilterIcon />&nbsp;{filterCategoryLabel}
                    </MenuToggle>
                  )}
                >
                  <SelectList>
                    {FILTER_OPTIONS.map((opt) => (
                      <SelectOption key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectOption>
                    ))}
                  </SelectList>
                </Select>
              </ToolbarItem>
              <ToolbarFilter
                labels={activeFilters.name}
                deleteLabel={(_category, label) => {
                  setActiveFilters((prev) => ({
                    ...prev,
                    name: prev.name.filter((f) => f !== (label as string)),
                  }));
                }}
                deleteLabelGroup={() => {
                  setActiveFilters((prev) => ({ ...prev, name: [] }));
                }}
                categoryName={t('Name')}
                showToolbarItem={filterCategory === 'name'}
              >
                <SearchInput
                  placeholder={t('Filter by name...')}
                  value={filterValue}
                  onChange={(_event, value) => setFilterValue(value)}
                  onSearch={() => addFilter()}
                  onClear={() => setFilterValue('')}
                />
              </ToolbarFilter>
              <ToolbarFilter
                labels={activeFilters.status}
                deleteLabel={(_category, label) => {
                  setActiveFilters((prev) => ({
                    ...prev,
                    status: prev.status.filter((f) => f !== (label as string)),
                  }));
                }}
                deleteLabelGroup={() => {
                  setActiveFilters((prev) => ({ ...prev, status: [] }));
                }}
                categoryName={t('Status')}
                showToolbarItem={filterCategory === 'status'}
              >
                <SearchInput
                  placeholder={t('Filter by status...')}
                  value={filterValue}
                  onChange={(_event, value) => setFilterValue(value)}
                  onSearch={() => addFilter()}
                  onClear={() => setFilterValue('')}
                />
              </ToolbarFilter>
              <ToolbarFilter
                labels={activeFilters['bmc-address']}
                deleteLabel={(_category, label) => {
                  setActiveFilters((prev) => ({
                    ...prev,
                    'bmc-address': prev['bmc-address'].filter((f) => f !== (label as string)),
                  }));
                }}
                deleteLabelGroup={() => {
                  setActiveFilters((prev) => ({ ...prev, 'bmc-address': [] }));
                }}
                categoryName={t('BMC Address')}
                showToolbarItem={filterCategory === 'bmc-address'}
              >
                <SearchInput
                  placeholder={t('Filter by BMC address...')}
                  value={filterValue}
                  onChange={(_event, value) => setFilterValue(value)}
                  onSearch={() => addFilter()}
                  onClear={() => setFilterValue('')}
                />
              </ToolbarFilter>
            </ToolbarGroup>
          </ToolbarContent>
        </Toolbar>

        {filteredHosts.length === 0 ? (
          <EmptyState
            titleText={t('No BareMetalHosts found')}
            icon={ServerIcon}
            headingLevel="h2"
          >
            <EmptyStateBody>
              {t('Create BareMetalHost resources in your cluster to see them here.')}
            </EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label={t('Bare Metal Hosts')}>
            <Thead>
              <Tr>
                <Th>{t('Name')}</Th>
                <Th>{t('IP')}</Th>
                <Th className="pf-m-hidden pf-m-visible-on-sm">{t('Namespace')}</Th>
                <Th className="pf-m-hidden pf-m-visible-on-sm">{t('Status')}</Th>
                <Th className="pf-m-hidden pf-m-visible-on-md">{t('Power')}</Th>
                <Th className="pf-m-hidden pf-m-visible-on-lg">{t('Management Address')}</Th>
                <Th className="pf-m-hidden pf-m-visible-on-lg">{t('Hardware')}</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {filteredHosts.map((bmh) => {
                const state = getProvisioningState(bmh);
                const powered = isPoweredOn(bmh);
                const statusConfig = STATUS_ICON_CONFIG[state] || STATUS_ICON_CONFIG.unknown;
                const rowKey = bmh.metadata.uid || `${bmh.metadata.namespace}/${bmh.metadata.name}`;
                const ipInfo = ipByHost.get(rowKey) || null;
                return (
                  <Tr key={rowKey}>
                    <Td dataLabel={t('Name')}>
                      <span>{bmh.metadata.name}</span>
                      <div className="bmh-vendor-text">{getSystemVendorInfo(bmh)}</div>
                    </Td>
                    <Td dataLabel={t('IP')}>
                      <HostIpCell info={ipInfo} />
                    </Td>
                    <Td dataLabel={t('Namespace')} className="pf-m-hidden pf-m-visible-on-sm">
                      {bmh.metadata.namespace}
                    </Td>
                    <Td dataLabel={t('Status')} className="pf-m-hidden pf-m-visible-on-sm">
                      <span className="bmh-status-text">
                        <span className={statusConfig.colorClass}>{statusConfig.icon}</span>
                        {state}
                      </span>
                      {bmh.status?.errorMessage && (
                        <div className="bmh-error-msg">
                          {bmh.status.errorMessage.substring(0, 120)}
                          {bmh.status.errorMessage.length > 120 ? '...' : ''}
                        </div>
                      )}
                    </Td>
                    <Td dataLabel={t('Power')} className="pf-m-hidden pf-m-visible-on-md">
                      {powered ? (
                        <span className="bmh-status-text">
                          <span className="bmh-status--success"><OnRunningIcon /></span>
                          {t('On')}
                        </span>
                      ) : (
                        <span className="bmh-status-text">
                          <span className="bmh-status--unknown"><PowerOffIcon /></span>
                          {t('Off')}
                        </span>
                      )}
                    </Td>
                    <Td dataLabel={t('Management Address')} className="pf-m-hidden pf-m-visible-on-lg">
                      {bmh.spec.bmc?.address || '—'}
                    </Td>
                    <Td dataLabel={t('Hardware')} className="pf-m-hidden pf-m-visible-on-lg">
                      {getHardwareSummary(bmh)}
                    </Td>
                    <Td isActionCell>
                      <ActionsColumn items={getRowActions(bmh)} />
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        )}
      </PageSection>

      {actionModal && (
        <Modal
          variant="small"
          isOpen
          onClose={() => { setActionModal(null); setActionError(null); }}
        >
          <ModalHeader title={actionModal.type === 'deprovision' ? t('Deprovision Host') : t('Delete Host')} />
          <ModalBody>
            {actionError && (
              <Alert variant="danger" title={t('Error')} isInline>
                {actionError}
              </Alert>
            )}
            <p>
              {actionModal.type === 'deprovision'
                ? t('Are you sure you want to deprovision {{name}}? This will remove the deployed image and power off the host.', { name: actionModal.bmh.metadata.name })
                : t('Are you sure you want to delete {{name}}? This action cannot be undone.', { name: actionModal.bmh.metadata.name })
              }
            </p>
          </ModalBody>
          <ModalFooter>
            <Button
              key="confirm"
              variant="danger"
              onClick={() => {
                if (actionModal.type === 'deprovision') {
                  handleDeprovision(actionModal.bmh);
                } else {
                  handleDeleteHost(actionModal.bmh);
                }
              }}
              isLoading={actionInProgress}
              isDisabled={actionInProgress}
            >
              {actionModal.type === 'deprovision' ? t('Deprovision') : t('Delete')}
            </Button>
            <Button key="cancel" variant="link" onClick={() => { setActionModal(null); setActionError(null); }}>
              {t('Cancel')}
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </>
  );
};

export default BaremetalNodesPage;
