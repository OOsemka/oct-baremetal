# AGENTS.md — Bare Metal Hosts (OCT extension)

This is **OpenShift Community Tools (OCT)**, a **community project**, not an official Red Hat supported product. Do not describe it as official Red Hat software.

This repository is the **Bare Metal Hosts** ConsolePlugin: inventory, register, and deploy. It is **not** the OCT storefront. Catalog hubs live in `oct-storefront`. Network Bond lives in `oct-network-bond`.

## Identifiers

| | Value |
| --- | --- |
| Plugin ID / ConsolePlugin / `package.json` `consolePlugin.name` | **`oct-baremetal`** |
| Image | `quay.io/<org>/oct-baremetal:0.1.2-ocp4.22` (`<semver>-ocp<major.minor>`; optional aliases `:0.1.2` / `:4.22`) |
| i18n | `plugin__oct-baremetal` |
| Proxy | `/api/proxy/plugin/oct-baremetal/discovery-service` |

**Working tree:** this folder may still be named `openshift-baremetal-dashboard`. It can be renamed to `oct-baremetal` later. Do not delete this tree to “clean up.”

**Migration:** lab clusters that still run `openshift-baremetal-dashboard` must **reinstall** (remove the old ConsolePlugin from `spec.plugins`, delete the old namespace, apply the new manifests). Changing the plugin ID is a breaking install. Do not `oc apply` unless asked.

Display name is **Bare Metal Hosts**.

**Current version:** `0.1.2` (package.json / consolePlugin.version).

## Architecture (short)

| Piece | Role |
| --- | --- |
| Console dynamic plugin (`src/`, `console-extensions.json`) | Baremetal routes only. Kubernetes API via Console SDK. |
| Plugin nginx container (`Containerfile`, `deploy/`) | Serves webpack `dist/`. ConsolePlugin **oct-baremetal**. |
| Discovery service (`discovery-service/`) | In-cluster Go proxy for BMC Redfish discover and image-cache HTTP for Ironic. |

## Exposed modules

| Module | Route | Description |
| --- | --- | --- |
| `BaremetalNodesPage` | `/baremetal/nodes` | Inventory table of BareMetalHosts with status, BMC, power state, provisioning. Register and Deploy buttons. |
| `RegisterWizardPage` | `/baremetal/nodes/register` | Four-step PatternFly wizard: **BMC Connection** → **Host Configuration** → **Network Configuration** → **Review & Register**. |
| `DeployPage` | `/baremetal/nodes/deploy/:ns/:name` | OS image tiles from CDI DataSources/DataImportCrons, image-cache prepare, BMH provision with cloud-init and NMState network config. |

## Register wizard flow

1. **BMC Connection** — user enters BMC address and credentials; Discover POSTs to `/api/proxy/plugin/oct-baremetal/discovery-service/api/v1/discover`; Go service queries Redfish (`/redfish/v1/Systems`, NICs, storage) and returns model/CPU/RAM/NICs/disks plus suggested hostname, boot MAC, and Metal3 BMC address (`redfish`/`idrac`/etc.).
2. **Host Configuration** — name, boot MAC, BMC address (prefilled from discovery).
3. **Network Configuration** — optional NMState key-file content for pre-provisioning network.
4. **Review & Register** — creates BMC Secret, optional NMState Secret, and `BareMetalHost` CR.

## Deploy page flow

1. Loads the BMH for `:ns/:name` (parsed from `window.location.pathname`).
2. Lists CDI `DataSource`s and `DataImportCron`s as OS image tiles.
3. Can prepare PVC/registry images through the image-cache API (download, convert raw, serve HTTP).
4. On Deploy: patches BMH with `spec.image` (HTTP URL + sha256 checksum, `format: raw` when cached), sets `online: true`, optionally creates cloud-init `userData` and reuses preprovisioning network config as `networkData`.

## Dynamic StorageClass resolution

No StorageClass logic in the frontend. Discovery-service reads the `image-cache` PVC `spec.storageClassName` as the Add-chosen class; for temp snapshot-restore PVCs it keeps that class if the CSI driver matches, otherwise lists StorageClasses and prefers: kubevirt default virt class → cluster default → first matching provisioner. The PVC manifest omits `storageClassName` so the cluster default (or Add override) applies.

## OpenShift and extension versions

Two axes in the catalog: git tag **`v1.x.x`** (semver) and optional branch **`ocp-X.Y`** when PatternFly or APIs diverge. Image tags **always** `<semver>-ocp<major.minor>` (e.g. `0.1.2-ocp4.22`). Storefront Add installs the newest stable semver compatible with the cluster; Update is explicit; one ConsolePlugin name runs one version.

- Git: `main` tracks the newest supported minor (currently **4.22**). Optional `ocp-4.22`, `ocp-4.21`.
- Images: `oct-baremetal:0.1.2-ocp4.22` and `:0.1.2-ocp4.21`; discovery `oct-baremetal-discovery` with the same pair. **Always publish both** OpenShift minor tags (same digest if bits match). Never catalog `:0.1.2` unless that combined tag exists and is public.
- PatternFly 6 on 4.22; do not mix PF majors on one branch.

## Navigation (React Router v6 via v5-compat)

This plugin **does not** register the Community Tools section or hubs. Open inventory from the storefront Compute tile or:

- `/baremetal/nodes`
- `/baremetal/nodes/register`
- `/baremetal/nodes/deploy/:ns/:name`

All three pages import `useNavigate` from `react-router-dom-v5-compat` (^6.30.0, bridging v6 over the Console's v5 host). Inventory navigates to Register or Deploy; register/deploy cancel/success navigates back to inventory. Deploy reads `:ns/:name` via `window.location.pathname` (`parsePathParams`), not route params.

Do not add those paths as left-nav hrefs here.

## PatternFly 6

- Import from `@patternfly/react-core` ^6. Do **not** import PatternFly CSS.
- Prefix new CSS `bmh-`. Include `CommunityDisclaimer` on tool pages.
- Disclaimer title: “Community project. Not officially supported by Red Hat.”

## Discovery-service

- Proxy aliases in `deploy/consoleplugin.yaml` (`discovery-service`, `bmh-proxy`).
- Go service exposes `POST /api/v1/discover`, image-cache routes (`prepare`, `status`, `serve`), `POST /api/v1/log`, and `GET /healthz` over HTTPS 8443 / HTTP 8080.
- Frontend proxy: `/api/proxy/plugin/oct-baremetal/discovery-service`.
- `image-cache` PVC (100Gi) mounted at `/data/image-cache`; Recreate strategy because RWO. Cached OS images are served as HTTP for Ironic provisioning. Missing PVC → discovery-service Pending → console proxy 502.
- Do not log BMC passwords, kube tokens, or cloud-init secrets.
- **No environment-specific hardcoding.** Never put a lab StorageClass, VLAN, CIDR, hostname, or similar into code or install YAML. Omit the field (cluster default), read it from the cluster, or use what the admin chose at Add. See `.cursor/rules/oct-no-env-hardcoding.mdc`.

## Companion images

The deploy bundle (`catalog/deploy/oct-baremetal.yaml` in the storefront) references a sidecar image with its own independent version. When bumping either image, update both the deploy YAML and this section.

| Image | Current version | Quay repo |
| --- | --- | --- |
| `oct-baremetal-discovery` | **1.1.1** | `quay.io/openshift-community-tools/oct-baremetal-discovery` |

The discovery-service version (`1.1.0`) is independent of the plugin version (`0.1.2`). Both are listed in the deploy bundle. After rebuilding either image, update the deploy YAML in the storefront, rebuild the storefront image, and run `scripts/validate-catalog.sh`. See `oct-release-checklist.mdc`.

## Do-not-break list

Do **not** change unless you are deliberately migrating a live cluster:

- Baremetal routes listed above
- Inventory, register wizard, deploy, and discovery-service proxy behavior
- Plugin ID `oct-baremetal` (old ID `openshift-baremetal-dashboard` is retired)

## Catalog tile

Storefront `catalog/community.yaml`: `metadata.name: oct-baremetal`, `consolePlugin: oct-baremetal`, `spec.href: /baremetal/nodes` (must match `console-extensions.json`), `spec.versions[]` with semver + `openshift` and a **public combined image tag that exists**.

## Add must go Ready

Storefront **Add** can succeed (Namespace, ConsolePlugin, `spec.plugins`) while the plugin never becomes Ready. **Open** then 404s (no bundle; typical ImagePullBackOff / unpublished catalog tag). Follow **oct-storefront** `docs/extension-standard.md`: publish the **combined** tag the catalog lists (`:0.1.2-ocp4.22`, not only `:4.22` or `:0.1.2`); keep images public (no pull secret); include every required PVC/volume/RBAC/Service in the storefront bundle Add applies. This plugin **must** precreate PVC `image-cache` (100Gi) so `discovery-service` can schedule. Omit `storageClassName` for the cluster default; Add can pick a StorageClass (`communitytools.io/storage-class` or `spec.storageClassName`). Confirm the plugin **and** discovery-service Deployments are Running and `image-cache` is Bound before calling Add done.

Storefront **Add** also checks Metal3 `Provisioning/provisioning-configuration` `spec.watchAllNamespaces` and can patch `true` with the user’s console credentials. Inventory shows a warning if that field is missing/false and any host is outside `openshift-machine-api` (BareMetal Operator then only reconciles `openshift-machine-api`, so those hosts stay Unknown).

## Verify

```bash
yarn install
yarn verify   # ts-check, check-i18n, check-repo, build (same as CI)
```

`yarn check-i18n --fix` adds missing translation keys. Contributor workflow and the maintainer-only release steps: [CONTRIBUTING.md](CONTRIBUTING.md).
