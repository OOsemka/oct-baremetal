# Bare Metal Hosts (OpenShift Community Tools)

**Community project. Not officially supported by Red Hat.**

Standalone OpenShift Console plugin for Metal3 BareMetalHost inventory, BMC Redfish register, and golden-image deploy.

- **Plugin ID:** `oct-baremetal`
- **Version:** `0.1.1`
- **Image:** `quay.io/<org>/oct-baremetal:0.1.1-ocp4.22` and `:0.1.1-ocp4.21` (`<semver>-ocp<major.minor>`; always publish both minors; aliases `:0.1.1` / `:4.22` may still exist)
- **Git branch:** `main` / `ocp-4.22` (one `ocp-X.Y` branch per OpenShift minor)

This folder may still be named `openshift-baremetal-dashboard`. The plugin ID is `oct-baremetal`. Existing clusters that installed `openshift-baremetal-dashboard` need a **reinstall**. This is **not** the Community Tools catalog; hubs live in [oct-storefront](../oct-storefront). Network Bond is [oct-network-bond](../oct-network-bond).

Validated on OpenShift **4.22** (PatternFly 6).

## Routes

- `/baremetal/nodes` — inventory
- `/baremetal/nodes/register` — register wizard
- `/baremetal/nodes/deploy/:ns/:name` — deploy

Open from **Community Tools → Compute** after the storefront and this plugin are enabled.

## Architecture

| Component | Description |
| --- | --- |
| Console plugin (`src/`, `console-extensions.json`) | Inventory, register wizard, and deploy page. Uses `useNavigate` from `react-router-dom-v5-compat` (React Router v6 bridge). |
| Plugin nginx (`Containerfile`, `deploy/`) | Serves webpack `dist/`. ConsolePlugin **oct-baremetal**. |
| Discovery service (`discovery-service/`) | Go proxy: BMC Redfish discover (`POST /api/v1/discover`), image-cache download/convert/serve for Ironic, and logging. HTTPS 8443 / HTTP 8080. |

## Pages

| Route | Module | What it does |
| --- | --- | --- |
| `/baremetal/nodes` | `BaremetalNodesPage` | Inventory of BareMetalHosts with status, BMC address, power state, provisioning. Buttons for Register and Deploy. |
| `/baremetal/nodes/register` | `RegisterWizardPage` | Four-step wizard: BMC Connection (Redfish discover) → Host Configuration → Network Configuration (NMState) → Review & Register (creates BMC Secret + BareMetalHost). |
| `/baremetal/nodes/deploy/:ns/:name` | `DeployPage` | OS image tiles from CDI DataSources, image-cache prepare, BMH provision with `spec.image`, cloud-init, and NMState network data. |

## Install (image cache)

Storefront **Add** applies `catalog/deploy/oct-baremetal.yaml`, which **precreates** PVC `image-cache` (100Gi) before `discovery-service` so the pod can schedule. Omit `storageClassName` to use the cluster default StorageClass; the Add dialog can pick another class. Add also checks Metal3 `watchAllNamespaces` so BareMetal Operator reconciles hosts outside `openshift-machine-api`.

## Contributing — cluster-portable code

Do **not** hardcode environment-specific values: StorageClass names, VLAN/CIDR/bond names, lab domains, node names, or cluster URLs. Those belong to the target cluster. Omit the field for the cluster default, read the live object, or use the value chosen at storefront **Add**. Same rule for AI assistants: `.cursor/rules/oct-no-env-hardcoding.mdc`.

Documented `oc apply` (cluster-admin; do not apply unless asked):

```bash
oc apply -f discovery-service/deploy/image-cache-pvc.yaml
oc apply -f discovery-service/deploy/route.yaml
oc apply -f discovery-service/deploy/rbac.yaml
oc apply -f discovery-service/deploy/service.yaml
oc apply -f discovery-service/deploy/deployment.yaml
```

A missing `image-cache` PVC leaves discovery-service Pending; the console proxy then returns **502 Bad Gateway** on image prepare/cache.

## Build

```bash
yarn install
yarn build
```

Discovery-service: see [discovery-service/README.md](discovery-service/README.md). Do not commit BMC passwords or cluster tokens.
