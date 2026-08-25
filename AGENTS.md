# AGENTS.md — Bare Metal Hosts (OCT extension)

This is **OpenShift Community Tools (OCT)**, a **community project**, not an official Red Hat supported product. Do not describe it as official Red Hat software.

This repository is the **Bare Metal Hosts** ConsolePlugin: inventory, register, and deploy. It is **not** the OCT storefront. Catalog hubs live in `oct-storefront`. Network Bond lives in `oct-network-bond`.

## Identifiers

| | Value |
| --- | --- |
| Plugin ID / ConsolePlugin / `package.json` `consolePlugin.name` | **`oct-baremetal`** |
| Image | `quay.io/<org>/oct-baremetal:1.1.0-ocp4.22` (`<semver>-ocp<major.minor>`; optional aliases `:1.1.0` / `:4.22`) |
| i18n | `plugin__oct-baremetal` |
| Proxy | `/api/proxy/plugin/oct-baremetal/discovery-service` |

**Working tree:** this folder may still be named `openshift-baremetal-dashboard`. It can be renamed to `oct-baremetal` later. Do not delete this tree to “clean up.”

**Migration:** lab clusters that still run `openshift-baremetal-dashboard` must **reinstall** (remove the old ConsolePlugin from `spec.plugins`, delete the old namespace, apply the new manifests). Changing the plugin ID is a breaking install. Do not `oc apply` unless asked.

Display name is **Bare Metal Hosts**.

## Architecture (short)

| Piece | Role |
| --- | --- |
| Console dynamic plugin (`src/`, `console-extensions.json`) | Baremetal routes only. Kubernetes API via Console SDK. |
| Plugin nginx container (`Containerfile`, `deploy/`) | Serves webpack `dist/`. ConsolePlugin **oct-baremetal**. |
| Discovery service (`discovery-service/`) | In-cluster Go proxy for BMC Redfish discover and image-cache HTTP for Ironic. |

## OpenShift and extension versions

Two axes in the catalog: git tag **`v1.x.x`** (semver) and optional branch **`ocp-X.Y`** when PatternFly or APIs diverge. Image tags **always** `<semver>-ocp<major.minor>` (e.g. `1.1.0-ocp4.22`). Storefront Add installs the newest stable semver compatible with the cluster; Update is explicit; one ConsolePlugin name runs one version.

- Git: `main` tracks the newest supported minor (currently **4.22**). Optional `ocp-4.22`, `ocp-4.21`.
- Images: `oct-baremetal:1.1.0-ocp4.22`; discovery `oct-baremetal-discovery:1.1.0-ocp4.22`. Never catalog `:1.1.0` unless that combined tag exists and is public.
- PatternFly 6 on 4.22; do not mix PF majors on one branch.

## Navigation

This plugin **does not** register the Community Tools section or hubs. Open inventory from the storefront Compute tile or:

- `/baremetal/nodes`
- `/baremetal/nodes/register`
- `/baremetal/nodes/deploy/:ns/:name`

Do not add those paths as left-nav hrefs here.

## PatternFly 6

- Import from `@patternfly/react-core` ^6. Do **not** import PatternFly CSS.
- Prefix new CSS `bmh-`. Include `CommunityDisclaimer` on tool pages.
- Disclaimer title: “Community project. Not officially supported by Red Hat.”

## Discovery-service

- Proxy aliases in `deploy/consoleplugin.yaml` (`discovery-service`, `bmh-proxy`).
- Do not log BMC passwords, kube tokens, or cloud-init secrets.

## Do-not-break list

Do **not** change unless you are deliberately migrating a live cluster:

- Baremetal routes listed above
- Inventory, register wizard, deploy, and discovery-service proxy behavior
- Plugin ID `oct-baremetal` (old ID `openshift-baremetal-dashboard` is retired)

## Catalog tile

Storefront `catalog/community.yaml`: `metadata.name: oct-baremetal`, `consolePlugin: oct-baremetal`, `spec.href: /baremetal/nodes` (must match `console-extensions.json`), `spec.versions[]` with semver + `openshift` and a **public combined image tag that exists**.

## Add must go Ready

Storefront **Add** can succeed (Namespace, ConsolePlugin, `spec.plugins`) while the plugin never becomes Ready. **Open** then 404s (no bundle; typical ImagePullBackOff / unpublished catalog tag). Follow **oct-storefront** `docs/extension-standard.md`: publish the **combined** tag the catalog lists (`:1.1.0-ocp4.22`, not only `:4.22` or `:1.1.0`); keep images public (no pull secret); include every required PVC/volume/RBAC/Service in the storefront bundle Add applies. This plugin **must** precreate PVC `image-cache` (100Gi) so `discovery-service` can schedule. Omit `storageClassName` for the cluster default; Add can pick a StorageClass (`communitytools.io/storage-class` or `spec.storageClassName`). Confirm the plugin **and** discovery-service Deployments are Running and `image-cache` is Bound before calling Add done.

Storefront **Add** also checks Metal3 `Provisioning/provisioning-configuration` `spec.watchAllNamespaces` and can patch `true` with the user’s console credentials. Inventory shows a warning if that field is missing/false and any host is outside `openshift-machine-api` (BareMetal Operator then only reconciles `openshift-machine-api`, so those hosts stay Unknown).

## Verify

```bash
yarn install
yarn build
```
