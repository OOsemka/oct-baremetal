package main

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type RedfishClient struct {
	baseURL  string
	username string
	password string
	http     *http.Client
}

func NewRedfishClient(baseURL, username, password string) *RedfishClient {
	baseURL = strings.TrimRight(baseURL, "/")
	return &RedfishClient{
		baseURL:  baseURL,
		username: username,
		password: password,
		http: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			},
		},
	}
}

func (c *RedfishClient) get(path string) ([]byte, error) {
	url := c.baseURL + path
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}
	req.SetBasicAuth(c.username, c.password)
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connecting to BMC at %s: %w", c.baseURL, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading response: %w", err)
	}

	if resp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("authentication failed (401): check username and password")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %d from %s", resp.StatusCode, path)
	}

	return body, nil
}

// Discover queries the BMC and returns aggregated system information
// along with the resolved system path (e.g. /redfish/v1/Systems/System.Embedded.1).
func (c *RedfishClient) Discover() (*DiscoverResponse, string, error) {
	systemPath, err := c.resolveSystemPath()
	if err != nil {
		return nil, "", err
	}

	sysInfo, bootMode, err := c.fetchSystemInfo(systemPath)
	if err != nil {
		return nil, "", err
	}

	nics, err := c.fetchNICs(systemPath)
	if err != nil {
		return nil, "", fmt.Errorf("fetching NICs: %w", err)
	}

	storage := c.fetchStorage(systemPath)
	suggestedMAC := pickBootMAC(nics)
	suggestedName := buildSuggestedName(sysInfo)

	return &DiscoverResponse{
		Model:            sysInfo.Model,
		Manufacturer:     sysInfo.Manufacturer,
		SerialNumber:     sysInfo.SerialNumber,
		CpuModel:         sysInfo.ProcessorModel,
		CpuCores:         sysInfo.ProcessorCount,
		RamGb:            sysInfo.TotalMemoryGiB,
		NICs:             nics,
		Storage:          storage,
		SuggestedName:    suggestedName,
		SuggestedBootMac: suggestedMAC,
		BootMode:         bootMode,
	}, systemPath, nil
}

// resolveSystemPath queries /redfish/v1/Systems to find the first system member.
func (c *RedfishClient) resolveSystemPath() (string, error) {
	body, err := c.get("/redfish/v1/Systems")
	if err != nil {
		return "", fmt.Errorf("querying systems collection: %w", err)
	}

	var collection struct {
		Members []struct {
			ODataID string `json:"@odata.id"`
		} `json:"Members"`
	}
	if err := json.Unmarshal(body, &collection); err != nil {
		return "", fmt.Errorf("parsing systems collection: %w", err)
	}
	if len(collection.Members) == 0 {
		return "", fmt.Errorf("no systems found in Redfish collection")
	}

	return collection.Members[0].ODataID, nil
}

func (c *RedfishClient) fetchSystemInfo(systemPath string) (*SystemInfo, string, error) {
	body, err := c.get(systemPath)
	if err != nil {
		return nil, "", fmt.Errorf("fetching system info: %w", err)
	}

	var sys struct {
		Manufacturer string `json:"Manufacturer"`
		Model        string `json:"Model"`
		SerialNumber string `json:"SerialNumber"`
		UUID         string `json:"UUID"`
		BIOSVersion  string `json:"BiosVersion"`
		Boot         struct {
			BootSourceOverrideMode string `json:"BootSourceOverrideMode"`
		} `json:"Boot"`
		MemorySummary struct {
			TotalSystemMemoryGiB float64 `json:"TotalSystemMemoryGiB"`
		} `json:"MemorySummary"`
		ProcessorSummary struct {
			Count int    `json:"Count"`
			Model string `json:"Model"`
		} `json:"ProcessorSummary"`
	}
	if err := json.Unmarshal(body, &sys); err != nil {
		return nil, "", fmt.Errorf("parsing system info: %w", err)
	}

	bootMode := sys.Boot.BootSourceOverrideMode
	if bootMode == "" {
		bootMode = "Unknown"
	}

	return &SystemInfo{
		Manufacturer:   sys.Manufacturer,
		Model:          sys.Model,
		SerialNumber:   sys.SerialNumber,
		UUID:           sys.UUID,
		BIOSVersion:    sys.BIOSVersion,
		TotalMemoryGiB: int(sys.MemorySummary.TotalSystemMemoryGiB),
		ProcessorCount: sys.ProcessorSummary.Count,
		ProcessorModel: sys.ProcessorSummary.Model,
	}, bootMode, nil
}

func (c *RedfishClient) fetchNICs(systemPath string) ([]NIC, error) {
	ethPath := systemPath + "/EthernetInterfaces"
	body, err := c.get(ethPath)
	if err != nil {
		return nil, err
	}

	var collection struct {
		Members []struct {
			ODataID string `json:"@odata.id"`
		} `json:"Members"`
	}
	if err := json.Unmarshal(body, &collection); err != nil {
		return nil, fmt.Errorf("parsing NIC collection: %w", err)
	}

	var nics []NIC
	for _, member := range collection.Members {
		nic, err := c.fetchNICDetail(member.ODataID)
		if err != nil {
			continue
		}
		nics = append(nics, *nic)
	}

	return nics, nil
}

func (c *RedfishClient) fetchNICDetail(path string) (*NIC, error) {
	body, err := c.get(path)
	if err != nil {
		return nil, err
	}

	var eth struct {
		ID         string `json:"Id"`
		Name       string `json:"Name"`
		MACAddress string `json:"MACAddress"`
		SpeedMbps  int    `json:"SpeedMbps"`
		LinkStatus string `json:"LinkStatus"`
		IPv4       []struct {
			Address string `json:"Address"`
		} `json:"IPv4Addresses"`
	}
	if err := json.Unmarshal(body, &eth); err != nil {
		return nil, fmt.Errorf("parsing NIC detail: %w", err)
	}

	linkState := eth.LinkStatus
	if linkState == "LinkUp" {
		linkState = "Up"
	} else if linkState == "LinkDown" || linkState == "NoLink" {
		linkState = "Down"
	}

	var addrs []string
	for _, a := range eth.IPv4 {
		if a.Address != "" && a.Address != "0.0.0.0" {
			addrs = append(addrs, a.Address)
		}
	}
	if addrs == nil {
		addrs = []string{}
	}

	nicName := eth.ID
	if nicName == "" || nicName == eth.Name {
		nicName = eth.Name
	}

	return &NIC{
		ID:            eth.ID,
		Name:          nicName,
		MACAddress:    eth.MACAddress,
		SpeedMbps:     eth.SpeedMbps,
		LinkState:     linkState,
		IPv4Addresses: addrs,
	}, nil
}

func (c *RedfishClient) fetchStorage(systemPath string) []StorageDevice {
	storagePath := systemPath + "/Storage"
	body, err := c.get(storagePath)
	if err != nil {
		return []StorageDevice{}
	}

	var collection struct {
		Members []struct {
			ODataID string `json:"@odata.id"`
		} `json:"Members"`
	}
	if err := json.Unmarshal(body, &collection); err != nil {
		return []StorageDevice{}
	}

	var devices []StorageDevice
	for _, member := range collection.Members {
		devs := c.fetchStorageController(member.ODataID)
		devices = append(devices, devs...)
	}

	if devices == nil {
		return []StorageDevice{}
	}
	return devices
}

func (c *RedfishClient) fetchStorageController(path string) []StorageDevice {
	body, err := c.get(path)
	if err != nil {
		return nil
	}

	var ctrl struct {
		Drives []struct {
			ODataID string `json:"@odata.id"`
		} `json:"Drives"`
	}
	if err := json.Unmarshal(body, &ctrl); err != nil {
		return nil
	}

	var devices []StorageDevice
	for _, driveRef := range ctrl.Drives {
		dev := c.fetchDrive(driveRef.ODataID)
		if dev != nil {
			devices = append(devices, *dev)
		}
	}

	return devices
}

func (c *RedfishClient) fetchDrive(path string) *StorageDevice {
	body, err := c.get(path)
	if err != nil {
		return nil
	}

	var drive struct {
		Name             string  `json:"Name"`
		Model            string  `json:"Model"`
		MediaType        string  `json:"MediaType"`
		CapacityBytes    float64 `json:"CapacityBytes"`
		Protocol         string  `json:"Protocol"`
		SerialNumber     string  `json:"SerialNumber"`
		BlockSizeBytes   int     `json:"BlockSizeBytes"`
		RotationSpeedRPM int     `json:"RotationSpeedRPM"`
		Identifiers      []struct {
			DurableName       string `json:"DurableName"`
			DurableNameFormat string `json:"DurableNameFormat"`
		} `json:"Identifiers"`
	}
	if err := json.Unmarshal(body, &drive); err != nil {
		return nil
	}

	sizeGB := int(drive.CapacityBytes / 1_000_000_000)

	mediaType := drive.MediaType
	if mediaType == "" {
		if drive.RotationSpeedRPM > 0 {
			mediaType = "HDD"
		} else {
			mediaType = "SSD"
		}
	}

	name := drive.Name
	if name == "" {
		name = drive.Model
	}

	var wwn string
	for _, id := range drive.Identifiers {
		if id.DurableNameFormat == "NAA" || id.DurableNameFormat == "FC_WWN" || id.DurableNameFormat == "EUI" {
			wwn = id.DurableName
			break
		}
	}

	return &StorageDevice{
		Name:         name,
		SizeGB:       sizeGB,
		MediaType:    mediaType,
		Model:        drive.Model,
		SerialNumber: strings.TrimSpace(drive.SerialNumber),
		WWN:          wwn,
		Protocol:     drive.Protocol,
	}
}

// pickBootMAC selects the suggested boot MAC: first NIC with link Up, or the first NIC.
func pickBootMAC(nics []NIC) string {
	if len(nics) == 0 {
		return ""
	}
	for _, nic := range nics {
		if nic.LinkState == "Up" {
			return nic.MACAddress
		}
	}
	return nics[0].MACAddress
}

func buildSuggestedName(info *SystemInfo) string {
	sanitize := func(s string) string {
		s = strings.ToLower(s)
		var b strings.Builder
		prev := byte('-')
		for i := 0; i < len(s); i++ {
			c := s[i]
			if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
				b.WriteByte(c)
				prev = c
			} else if prev != '-' {
				b.WriteByte('-')
				prev = '-'
			}
		}
		return strings.Trim(b.String(), "-")
	}

	model := sanitize(info.Model)
	serial := sanitize(info.SerialNumber)
	if len(serial) > 8 {
		serial = serial[len(serial)-8:]
	}

	if model == "" {
		model = "host"
	}
	if serial == "" {
		return model
	}
	return model + "-" + serial
}
