# Contributing to Bare Metal Hosts

Thanks for helping. Bare Metal Hosts is part of OpenShift Community Tools (OCT), a
community project that is not officially supported by Red Hat. Bug fixes, new
options and docs improvements are all welcome. For larger changes, open an
issue first so we can agree on the approach before you spend time on it.

## Setup

Requirements: Node.js 20 and Corepack (it provides the Yarn version pinned in
`package.json`) and Go (version in `discovery-service/go.mod`) for the companion service.

```bash
corepack enable
yarn install
yarn verify    # type check, translation keys, repository rules, production build
```

For `discovery-service/`:

```bash
cd discovery-service && go vet ./... && go test ./...
```

The same checks run in GitHub Actions on every pull request. A pull request
can be merged when they pass and a maintainer has reviewed it.

## Test on your own cluster

Use a lab cluster you can afford to break.

Build your image and push it to a registry you own (make the repository public,
or add a pull secret):

```bash
podman build -t quay.io/<you>/oct-baremetal:dev -f Containerfile .
podman push quay.io/<you>/oct-baremetal:dev
```

**If Bare Metal Hosts is already installed from the storefront**, swap in your image:

```bash
oc set image deploy/oct-baremetal -n oct-baremetal plugin=quay.io/<you>/oct-baremetal:dev
```

**Otherwise** deploy the YAML in this repo with your image:

```bash
for f in namespace rbac service deployment consoleplugin; do
  sed 's|quay.io/cjanisze/oct-baremetal:[^ ]*|quay.io/<you>/oct-baremetal:dev|' deploy/$f.yaml | oc apply -f -
done
```

and enable the plugin in the console (skip if the storefront already enabled it):

```bash
oc patch console.operator cluster --type=json \
  -p '[{"op":"add","path":"/spec/plugins/-","value":"oct-baremetal"}]'
```

The page is at **Community Tools → Compute → Bare Metal Hosts (`/baremetal/nodes`)** (`/baremetal/nodes`). After pushing a new `:dev`
image, restart the plugin pod (`oc rollout restart deploy/oct-baremetal -n oct-baremetal`)
and reload the console.

**Discovery service (`oct-baremetal-discovery`)** (`discovery-service/`): build it with
`podman build -t quay.io/<you>/oct-baremetal-discovery:dev -f discovery-service/Containerfile discovery-service/` and push it. It runs as the `discovery-service` proxy; its Deployment and the `image-cache` PVC come from the storefront bundle (`catalog/deploy/oct-baremetal.yaml` in oct-storefront), so install from the storefront first and then `oc set image deploy/discovery-service -n oct-baremetal '*=quay.io/<you>/oct-baremetal-discovery:dev'`.

Not able to test on a cluster? Say so in the pull request and describe what you
checked instead (for example the page's YAML preview, or output of the functions
you changed). A maintainer tests it before the release.

## Rules

- **PatternFly 6** components only. Do not import PatternFly CSS; the console provides it.
- **Translations:** every UI string goes through `t('...')` and has an entry in
  `locales/en/plugin__oct-baremetal.json`. `yarn check-i18n --fix` adds missing ones.
- **No environment-specific values:** no hostnames, IPs, VLAN IDs, NIC names,
  StorageClasses, cluster URLs or tokens in code or docs. Read live cluster state
  and let the user choose.
- Do not break inventory, the register wizard, deploy or the discovery-service proxy. Keep the plugin ID `oct-baremetal` and the `/baremetal/...` routes.
- Never commit BMC passwords, kubeconfig tokens or other secrets, and never log them.
- New catalog tools go in separate `oct-<name>` repos plus a PR to `oct-storefront` `catalog/community.yaml`. Do not add hubs to this plugin.
- Start with [docs/architecture.md](docs/architecture.md) for the register and deploy flows.
- **Wording:** this is a community project; do not describe it as official Red Hat software.
- [AGENTS.md](AGENTS.md) describes the design in detail. It is also the guide
  for AI coding assistants, which are welcome; please review what they produce.

## Releases (maintainers)

Leave these to the maintainers. Do not change them in a pull request:

- the version in `package.json` (both places), README, AGENTS.md and the deploy YAML
- container images (`<version>-ocp4.22` and `-ocp4.21`, including the companion image; published tags are never overwritten)
- git tags and the storefront catalog rows

## License

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0), the license of this project.
