package main

import (
	"testing"
)

func TestParseRouteExternalURL(t *testing.T) {
	httpRoute := map[string]interface{}{
		"spec": map[string]interface{}{
			"host": "image-cache-oct-baremetal.apps.example.com",
		},
	}
	got := parseRouteExternalURL(httpRoute)
	want := "http://image-cache-oct-baremetal.apps.example.com"
	if got != want {
		t.Fatalf("http route: got %q want %q", got, want)
	}

	httpsRoute := map[string]interface{}{
		"spec": map[string]interface{}{
			"host": "image-cache-oct-baremetal.apps.example.com",
			"tls":  map[string]interface{}{"termination": "edge"},
		},
	}
	got = parseRouteExternalURL(httpsRoute)
	want = "https://image-cache-oct-baremetal.apps.example.com"
	if got != want {
		t.Fatalf("https route: got %q want %q", got, want)
	}

	if parseRouteExternalURL(map[string]interface{}{}) != "" {
		t.Fatal("empty route should yield empty URL")
	}
}

func TestApplyExternalURLs(t *testing.T) {
	img := &CachedImage{Name: "rhel9", FileName: "rhel9.img"}
	applyExternalURLs(img, "http://image-cache-oct-baremetal.apps.example.com/")
	if img.ExternalURL != "http://image-cache-oct-baremetal.apps.example.com/api/v1/image-cache/images/rhel9.img" {
		t.Fatalf("externalUrl: %s", img.ExternalURL)
	}
	if img.ExternalChecksumURL != "http://image-cache-oct-baremetal.apps.example.com/api/v1/image-cache/images/rhel9.img.sha256sum" {
		t.Fatalf("externalChecksumUrl: %s", img.ExternalChecksumURL)
	}

	bare := &CachedImage{Name: "rhel9"}
	applyExternalURLs(bare, "http://cache.example.com")
	if bare.ExternalURL != "http://cache.example.com/api/v1/image-cache/images/rhel9.img" {
		t.Fatalf("inferred fileName: %s", bare.ExternalURL)
	}

	applyExternalURLs(img, "")
	if img.ExternalURL == "" {
		t.Fatal("empty base should not clear existing external URL")
	}
}

func TestGetExternalBaseURLEnvOverride(t *testing.T) {
	t.Setenv("IMAGE_CACHE_EXTERNAL_URL", "http://override.example.com/")
	mgr := &ImageCacheManager{images: map[string]*CachedImage{}}
	got := mgr.getExternalBaseURL()
	if got != "http://override.example.com" {
		t.Fatalf("got %q", got)
	}
	if mgr.externalBaseURL != got {
		t.Fatalf("not cached: %q", mgr.externalBaseURL)
	}
}
