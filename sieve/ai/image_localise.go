package ai

import (
	"crypto/md5"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"sieve/store"
)

var remoteImgPattern = regexp.MustCompile(`!\[([^\]]*)\]\((https?://[^)]+)\)`)

// localiseImages scans content for remote image URLs, fetches each one with a
// plain HTTP GET, saves to docDir, and rewrites the URL to store.AssetURL(docUUID,
// filename) so it is served by the internal asset handler. Images that fail to
// fetch are left with their original remote URL.
func localiseImages(content, docDir, docUUID string) string {
	return remoteImgPattern.ReplaceAllStringFunc(content, func(match string) string {
		m := remoteImgPattern.FindStringSubmatch(match)
		if len(m) < 3 {
			return match
		}
		alt, imgURL := m[1], m[2]
		localPath, err := fetchAndSaveImage(imgURL, docDir)
		if err != nil {
			return match
		}
		filename := filepath.Base(localPath)
		return fmt.Sprintf("![%s](%s)", alt, store.AssetURL(docUUID, filename))
	})
}

func fetchAndSaveImage(imgURL, saveDir string) (string, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(imgURL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch: status %d", resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	ext := extensionFromContentType(resp.Header.Get("Content-Type"))
	hash := fmt.Sprintf("%x", md5.Sum([]byte(imgURL)))[:8]
	filename := "img-" + hash + ext

	if err := os.MkdirAll(saveDir, 0755); err != nil {
		return "", err
	}
	outPath := filepath.Join(saveDir, filename)
	return outPath, os.WriteFile(outPath, data, 0644)
}

func extensionFromContentType(ct string) string {
	switch {
	case strings.Contains(ct, "jpeg"), strings.Contains(ct, "jpg"):
		return ".jpg"
	case strings.Contains(ct, "gif"):
		return ".gif"
	case strings.Contains(ct, "webp"):
		return ".webp"
	case strings.Contains(ct, "svg"):
		return ".svg"
	default:
		return ".png"
	}
}
