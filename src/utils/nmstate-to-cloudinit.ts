/**
 * Converts nmstate YAML configuration to cloud-init runcmd nmcli commands.
 * Supports single NIC ethernet, bond, and VLAN configurations.
 */

interface NmstateInterface {
  name: string;
  type: string;
  state: string;
  ipv4?: {
    enabled: boolean;
    dhcp: boolean;
    address?: Array<{ ip: string; 'prefix-length': number }>;
  };
  ipv6?: {
    enabled: boolean;
  };
  'link-aggregation'?: {
    mode: string;
    options?: Record<string, string>;
    port: string[];
  };
  vlan?: {
    'base-iface': string;
    id: number;
  };
}

interface NmstateConfig {
  'dns-resolver'?: {
    config?: {
      server?: string[];
    };
  };
  interfaces?: NmstateInterface[];
  routes?: {
    config?: Array<{
      destination: string;
      'next-hop-address': string;
      'next-hop-interface': string;
      'table-id'?: number;
    }>;
  };
}

function parseSimpleYaml(yaml: string): NmstateConfig {
  try {
    return JSON.parse(yaml);
  } catch {
    return {};
  }
}

export function nmstateToCloudInitRuncmd(nmstateJson: string): string[] {
  const config = parseSimpleYaml(nmstateJson);
  const cmds: string[] = [];

  cmds.push('sh -c "nmcli -g UUID connection show | xargs -I {} nmcli connection delete uuid {} || true"');

  const interfaces = config.interfaces || [];
  const dnsServers = config['dns-resolver']?.config?.server || [];
  const routes = config.routes?.config || [];

  const bondIface = interfaces.find((i) => i.type === 'bond');
  const vlanIface = interfaces.find((i) => i.type === 'vlan');
  const ethernetIface = interfaces.find((i) => i.type === 'ethernet');

  if (bondIface) {
    const agg = bondIface['link-aggregation'];
    if (agg) {
      const bondOpts: string[] = [`mode=${agg.mode}`];
      if (agg.options) {
        for (const [k, v] of Object.entries(agg.options)) {
          bondOpts.push(`${k}=${v}`);
        }
      }

      const bondIpMethod = bondIface.ipv4?.enabled && !bondIface.ipv4?.dhcp ? 'manual' : 'disabled';
      let bondCmd = `nmcli connection add type bond con-name ${bondIface.name} ifname ${bondIface.name} bond.options "${bondOpts.join(',')}" ipv4.method ${bondIpMethod} ipv6.method disabled`;

      if (bondIpMethod === 'manual' && bondIface.ipv4?.address?.length) {
        const addr = bondIface.ipv4.address[0];
        bondCmd += ` ipv4.addresses ${addr.ip}/${addr['prefix-length']}`;
        const route = routes.find((r) => r['next-hop-interface'] === bondIface.name);
        if (route) bondCmd += ` ipv4.gateway ${route['next-hop-address']}`;
        if (dnsServers.length) bondCmd += ` ipv4.dns ${dnsServers.join(',')}`;
      }

      cmds.push(bondCmd);

      agg.port.forEach((port, idx) => {
        cmds.push(
          `nmcli connection add type ethernet con-name ${bondIface.name}-port${idx + 1} ifname ${port} master ${bondIface.name}`,
        );
      });
    }
  }

  if (vlanIface && vlanIface.vlan) {
    let vlanCmd = `nmcli connection add type vlan con-name ${vlanIface.name} ifname ${vlanIface.name} dev ${vlanIface.vlan['base-iface']} id ${vlanIface.vlan.id}`;

    if (vlanIface.ipv4?.enabled && !vlanIface.ipv4?.dhcp && vlanIface.ipv4?.address?.length) {
      const addr = vlanIface.ipv4.address[0];
      vlanCmd += ` ipv4.method manual ipv4.addresses ${addr.ip}/${addr['prefix-length']}`;
      const route = routes.find((r) => r['next-hop-interface'] === vlanIface.name);
      if (route) vlanCmd += ` ipv4.gateway ${route['next-hop-address']}`;
      if (dnsServers.length) vlanCmd += ` ipv4.dns ${dnsServers.join(',')}`;
    }
    vlanCmd += ' ipv6.method disabled';

    cmds.push(vlanCmd);
    cmds.push(`nmcli connection up ${vlanIface.name}`);
  }

  if (ethernetIface && !bondIface) {
    let ethCmd = `nmcli connection add type ethernet con-name ${ethernetIface.name} ifname ${ethernetIface.name}`;

    if (ethernetIface.ipv4?.enabled && !ethernetIface.ipv4?.dhcp && ethernetIface.ipv4?.address?.length) {
      const addr = ethernetIface.ipv4.address[0];
      ethCmd += ` ipv4.method manual ipv4.addresses ${addr.ip}/${addr['prefix-length']}`;
      const route = routes.find((r) => r['next-hop-interface'] === ethernetIface.name);
      if (route) ethCmd += ` ipv4.gateway ${route['next-hop-address']}`;
      if (dnsServers.length) ethCmd += ` ipv4.dns ${dnsServers.join(',')}`;
    }
    ethCmd += ' ipv6.method disabled';

    cmds.push(ethCmd);
    cmds.push(`nmcli connection up ${ethernetIface.name}`);
  }

  return cmds;
}
