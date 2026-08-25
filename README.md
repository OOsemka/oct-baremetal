# Bare Metal Hosts (OpenShift Community Tools)

**Community project. Not officially supported by Red Hat.**

Standalone OpenShift Console plugin for Metal3 BareMetalHost inventory, BMC Redfish register, and golden-image deploy.

- **Plugin ID:** `oct-baremetal`
- **Image:** `quay.io/<org>/oct-baremetal:1.1.0-ocp4.22` (`<semver>-ocp<major.minor>`; aliases `:1.1.0` / `:4.22` may still exist)
- **Git branch:** `main` / `ocp-4.22` (one `ocp-X.Y` branch per OpenShift minor)

This folder may still be named `openshift-baremetal-dashboard`. The plugin ID is `oct-baremetal`. Existing clusters that installed `openshift-baremetal-dashboard` need a **reinstall**. This is **not** the Community Tools catalog; hubs live in [oct-storefront](../oct-storefront). Network Bond is [oct-network-bond](../oct-network-bond).

Validated on OpenShift **4.22** (PatternFly 6).

## Routes

- `/baremetal/nodes` — inventory
- `/baremetal/nodes/register` — register wizard
- `/baremetal/nodes/deploy/:ns/:name` — deploy

Open from **Community Tools → Compute** after the storefront and this plugin are enabled.

## Build

```bash
yarn install
yarn build
```

Discovery-service: see [discovery-service/README.md](discovery-service/README.md). Do not commit BMC passwords or cluster tokens.
