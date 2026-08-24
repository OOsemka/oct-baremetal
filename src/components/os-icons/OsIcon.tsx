import React, { FC, SVGProps } from 'react';

import { OsFamily } from './detectOs';

type IconProps = SVGProps<SVGSVGElement>;

const svgProps = (title: string): IconProps => ({
  viewBox: '0 0 40 40',
  xmlns: 'http://www.w3.org/2000/svg',
  role: 'img',
  'aria-label': title,
  focusable: 'false',
});

/** Geometric fedora-hat mark (Red Hat / RHEL). */
export const RedHatIcon: FC<IconProps> = (props) => (
  <svg {...svgProps('Red Hat')} {...props}>
    <path
      fill="#EE0000"
      d="M6.5 29.2c4.2 2.6 22.8 2.6 27 0 .9-.5 1.2-1.4.6-2.1-.5-.6-1.4-.7-2.2-.4-3.6 1.4-19.6 1.4-23.2 0-.8-.3-1.7-.2-2.2.4-.6.7-.3 1.6.6 2.1Z"
    />
    <path
      fill="#EE0000"
      d="M11.8 27.2c.4-6.6 3.6-12.4 8.2-14.2 4.8-1.9 9.8.8 11.2 6.4 1 4.2-.2 7.4-1.4 8.2-2.2 1.4-18.4 1.2-18-.4Z"
    />
    <path
      fill="#C00000"
      d="M13.5 23.8c3.6-1.6 9.6-1.6 13.2 0 .4.2.6.6.4 1-.2.4-.6.5-1 .3-3.2-1.3-8.4-1.3-11.6 0-.4.2-.8.1-1-.3-.2-.4 0-.8.4-1Z"
    />
  </svg>
);

/** Blue disc with a geometric f (Fedora-inspired). */
export const FedoraIcon: FC<IconProps> = (props) => (
  <svg {...svgProps('Fedora')} {...props}>
    <circle cx="20" cy="20" r="16" fill="#3C6EB4" />
    <path
      fill="#fff"
      d="M17.2 11.5h7.2c.9 0 1.6.7 1.6 1.6s-.7 1.6-1.6 1.6h-4.4v3.2h3.6c.7 0 1.3.6 1.3 1.3s-.6 1.3-1.3 1.3h-3.6V27c0 .9-.7 1.6-1.6 1.6s-1.6-.7-1.6-1.6V13.1c0-.9.7-1.6 1.6-1.6Z"
    />
  </svg>
);

/** Four-color cardinal marks (CentOS-inspired). */
export const CentOSIcon: FC<IconProps> = (props) => (
  <svg {...svgProps('CentOS')} {...props}>
    <circle cx="20" cy="9.5" r="5.2" fill="#9CD023" />
    <circle cx="30.5" cy="20" r="5.2" fill="#932279" />
    <circle cx="20" cy="30.5" r="5.2" fill="#262577" />
    <circle cx="9.5" cy="20" r="5.2" fill="#147EB8" />
    <circle cx="20" cy="20" r="3.2" fill="#4D4D4D" />
  </svg>
);

/** Four-pane window (Windows-inspired). */
export const WindowsIcon: FC<IconProps> = (props) => (
  <svg {...svgProps('Windows')} {...props}>
    <rect x="6" y="6" width="12.5" height="12.5" rx="1.2" fill="#0078D4" />
    <rect x="21.5" y="6" width="12.5" height="12.5" rx="1.2" fill="#0078D4" />
    <rect x="6" y="21.5" width="12.5" height="12.5" rx="1.2" fill="#0078D4" />
    <rect x="21.5" y="21.5" width="12.5" height="12.5" rx="1.2" fill="#0078D4" />
  </svg>
);

/** Orange disc with three satellite circles (Ubuntu-inspired). */
export const UbuntuIcon: FC<IconProps> = (props) => (
  <svg {...svgProps('Ubuntu')} {...props}>
    <circle cx="20" cy="20" r="16" fill="#E95420" />
    <circle cx="20" cy="20" r="5.2" fill="#fff" />
    <circle cx="20" cy="7.8" r="3.4" fill="#fff" />
    <circle cx="30.6" cy="26.1" r="3.4" fill="#fff" />
    <circle cx="9.4" cy="26.1" r="3.4" fill="#fff" />
  </svg>
);

/** Red spiral (Debian-inspired). */
export const DebianIcon: FC<IconProps> = (props) => (
  <svg {...svgProps('Debian')} {...props}>
    <path
      d="M20 7.5c7.2 0 12.5 5 12.5 11.6 0 7.4-6.2 13.4-14.2 12.2-2.2-.3-3.6-2.4-2.8-4.5.6-1.5 2.2-2.3 3.8-2.1 4.2.5 7.2-2.2 7.2-5.8 0-3.4-2.8-6-6.5-6-4.6 0-7.8 3.8-7.8 8.8 0 8.2 6.6 14.6 15.2 12"
      fill="none"
      stroke="#A80030"
      strokeWidth="2.6"
      strokeLinecap="round"
    />
  </svg>
);

/** Red ring (Oracle Linux-inspired). */
export const OracleIcon: FC<IconProps> = (props) => (
  <svg {...svgProps('Oracle Linux')} {...props}>
    <circle cx="20" cy="20" r="13" fill="none" stroke="#C74634" strokeWidth="5" />
  </svg>
);

/** Geometric penguin for generic Linux. Navy + white stays visible on dark cards. */
export const LinuxIcon: FC<IconProps> = (props) => (
  <svg {...svgProps('Linux')} {...props}>
    <ellipse cx="20" cy="24" rx="10" ry="12" fill="#1E3A5F" />
    <ellipse cx="20" cy="26" rx="6.2" ry="8.5" fill="#F4F7FA" />
    <circle cx="20" cy="12.5" r="6.4" fill="#1E3A5F" />
    <circle cx="17.6" cy="11.8" r="1.5" fill="#F4F7FA" />
    <circle cx="22.4" cy="11.8" r="1.5" fill="#F4F7FA" />
    <circle cx="17.8" cy="12" r="0.7" fill="#1E3A5F" />
    <circle cx="22.6" cy="12" r="0.7" fill="#1E3A5F" />
    <path fill="#E87722" d="M20 13.4 16.8 16.2h6.4L20 13.4Z" />
    <ellipse cx="14.2" cy="35.2" rx="3.4" ry="1.6" fill="#E87722" />
    <ellipse cx="25.8" cy="35.2" rx="3.4" ry="1.6" fill="#E87722" />
  </svg>
);

const ICONS: Record<OsFamily, FC<IconProps>> = {
  rhel: RedHatIcon,
  fedora: FedoraIcon,
  centos: CentOSIcon,
  windows: WindowsIcon,
  ubuntu: UbuntuIcon,
  debian: DebianIcon,
  oracle: OracleIcon,
  linux: LinuxIcon,
};

export const OsIcon: FC<{ family: OsFamily; className?: string }> = ({
  family,
  className,
}) => {
  const Icon = ICONS[family];
  return (
    <span className={className || 'bmh-os-tile-logo'} aria-hidden>
      <Icon />
    </span>
  );
};
