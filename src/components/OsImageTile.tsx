import React, { FC } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Label,
  Tooltip,
} from '@patternfly/react-core';
import { InfoCircleIcon } from '@patternfly/react-icons';

import { DataSourceKind } from '../utils/k8s-resources';
import { detectOsFamily, OsIcon } from './os-icons';

export type ImageSourceKind = 'http' | 'registry' | 'pvc';

export type OsImageTileProps = {
  ds: DataSourceKind;
  isSelected: boolean;
  isCached: boolean;
  resolved?: { url: string; type: string };
  onSelect: () => void;
};

const getImageDisplayName = (ds: DataSourceKind): string => {
  const name = ds.metadata.name;
  return name
    .replace(/-\d+$/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

const sourceBadge = (
  kind: ImageSourceKind,
): { label: string; color: 'green' | 'orange' | 'grey' } => {
  switch (kind) {
    case 'registry':
      return { label: 'Registry', color: 'orange' };
    case 'http':
      return { label: 'HTTP', color: 'green' };
    default:
      return { label: 'PVC', color: 'grey' };
  }
};

const sourceKindFromResolved = (
  resolved?: { url: string; type: string },
): ImageSourceKind => {
  if (!resolved) {
    return 'pvc';
  }
  return resolved.type === 'registry' ? 'registry' : 'http';
};

/**
 * Selectable OS / DataSource tile. PatternFly 6 clickable+selectable cards rely on
 * Console-injected CSS to stretch the radio label over the card; combining
 * isClickable with isHidden clips that overlay and leaves no onClick. A native
 * button hit-target is used instead so click and keyboard selection always work.
 */
const OsImageTile: FC<OsImageTileProps> = ({
  ds,
  isSelected,
  isCached,
  resolved,
  onSelect,
}) => {
  const { t } = useTranslation('plugin__oct-baremetal');
  const tileId = `bmh-os-tile-${ds.metadata.name}`;
  const titleId = `${tileId}-title`;
  const cachedId = `${tileId}-cached`;
  const displayName = getImageDisplayName(ds);
  const osFamily = detectOsFamily(ds);
  const sourceKind = sourceKindFromResolved(resolved);
  const badge = sourceBadge(sourceKind);

  return (
    <Card
      id={tileId}
      className={`bmh-os-tile${isSelected ? ' pf-m-selected' : ''}`}
      isFullHeight
    >
      <CardHeader>
        <div className="bmh-os-tile-header">
          <OsIcon family={osFamily} />
          <div className="bmh-os-tile-badges">
            {isCached && (
              <Label id={cachedId} isCompact color="blue">
                {t('Cached')}
              </Label>
            )}
            <Label isCompact color={badge.color}>
              {t(badge.label)}
            </Label>
          </div>
        </div>
      </CardHeader>
      <CardTitle id={titleId}>{displayName}</CardTitle>
      <CardBody>
        <code className="bmh-ds-name">{ds.metadata.name}</code>
        {resolved?.type === 'registry' && !isCached && (
          <div className="bmh-ds-source-url">
            <Tooltip
              content={t(
                'This image is sourced from a container registry ({{url}}). Click to select it, then use "Prepare image" to cache it for bare metal deployment.',
                { url: resolved.url },
              )}
            >
              <InfoCircleIcon className="bmh-ds-info-icon" />
            </Tooltip>
          </div>
        )}
        {resolved?.type === 'http' && (
          <div className="bmh-ds-resolved-url">
            <small>
              {resolved.url.length > 60 ? `${resolved.url.substring(0, 60)}...` : resolved.url}
            </small>
          </div>
        )}
      </CardBody>
      <button
        type="button"
        className="bmh-os-tile-hit"
        aria-pressed={isSelected}
        aria-labelledby={titleId}
        aria-describedby={isCached ? cachedId : undefined}
        title={isCached ? t('Already in the image cache') : undefined}
        onClick={onSelect}
      />
    </Card>
  );
};

export default OsImageTile;
