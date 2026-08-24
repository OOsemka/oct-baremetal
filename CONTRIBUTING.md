# Contributing — Bare Metal Hosts

This Console plugin is a **community project**, not an official Red Hat supported product. It is an **OCT** (`oct-baremetal`) module.

Start with [AGENTS.md](AGENTS.md) and [docs/architecture.md](docs/architecture.md).

## Ground rules

- OpenShift **4.22** Console: **PatternFly 6 only**. Do not import PatternFly CSS. Older OCP lines live on `ocp-X.Y` branches — do not mix PF majors on one branch.
- Do not break inventory, register wizard, deploy, or the discovery-service proxy.
- Plugin ID is **`oct-baremetal`**. Do not revert to `openshift-baremetal-dashboard` without a documented migration. Keep `/baremetal/...` routes.
- Do not commit BMC passwords, kubeconfig tokens, or other secrets.
- New catalog tools go in **separate `oct-<name>` repos** plus a PR to `oct-storefront` `catalog/community.yaml`. Do not add hubs to this plugin.

## Workflow

1. Branch from `main` (newest OCP) or `ocp-X.Y` for an older line.
2. Edit Baremetal pages under `src/components/`.
3. Run `yarn build` (and `yarn ts-check` if you touched types).
4. Open a pull request describing the click-path from Community Tools → Compute → Bare Metal Hosts.

You do **not** need to rebuild the plugin container for a frontend review. Cluster deploy is a separate maintainer step.
