module github.com/cjanisze/oct-baremetal/discovery-service

go 1.22

require github.com/OOsemka/oct-storefront/backend-security-kit v0.2.0-dev.1

require gopkg.in/yaml.v3 v3.0.1 // indirect

// Until backend-security-kit is released from OOsemka/oct-storefront, build against the
// security-framework fork's dev tag. Remove this line once the release is tagged.
replace github.com/OOsemka/oct-storefront/backend-security-kit => github.com/dsorrentino/oct-storefront/backend-security-kit v0.2.0-dev.1
