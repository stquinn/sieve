To create a link summary like WhatsApp, Slack, or iMessage, you need to go beyond the `<title>` tag. These apps use a standard called the **Open Graph Protocol (OGP)**, originally created by Facebook.

When you paste a link, their servers "scrape" the page specifically looking for `<meta>` tags that tell them exactly what title, description, and image to show.

### 1. The Key Metadata Tags
To get a "WhatsApp-style" preview, you need to look for these specific tags in the HTML `<head>`:

| Property | HTML Tag | Purpose |
| :--- | :--- | :--- |
| **Title** | `<meta property="og:title" content="...">` | The bold headline. |
| **Description** | `<meta property="og:description" content="...">` | The 1–2 lines of summary text. |
| **Image** | `<meta property="og:image" content="...">` | The thumbnail or large preview image. |
| **Site Name** | `<meta property="og:site_name" content="...">` | e.g., "YouTube" or "The New York Times". |

---

### 2. The Logic Flow
If you were to build this in Go, your code should follow a **Fallback Strategy**:
1.  **Check Open Graph first:** It’s usually curated by the site owner for social sharing.
2.  **Check Twitter Cards next:** Look for `<meta name="twitter:title">`.
3.  **Standard HTML as last resort:** If no "OG" tags exist, use the regular `<title>` and `<meta name="description">`.

---

### 3. Go Implementation (Using a Library)
While you can write a recursive parser manually, it becomes tedious to handle all the meta tag variations. A popular choice in Go is `[github.com/otiai10/opengraph](https://github.com/otiai10/opengraph)`.

**Install it:**
```bash
go get github.com/otiai10/opengraph/v2
```

**Code Example:**
```go
package main

import (
	"fmt"
	"github.com/otiai10/opengraph/v2"
)

func main() {
	url := "https://www.github.com"
	
	// This library handles the fetching and the fallback logic for you
	res, err := opengraph.Fetch(url)
	if err != nil {
		fmt.Println("Error:", err)
		return
	}

	fmt.Println("--- Link Summary ---")
	fmt.Printf("Title:       %s\n", res.Title)
	fmt.Printf("Description: %s\n", res.Description)
	fmt.Printf("Thumbnail:   %s\n", res.Image[0].URL) // Usually the first image found
	fmt.Printf("Site Name:   %s\n", res.SiteName)
}
```

---

### 4. Technical Challenges to Keep in Mind
*   **The User-Agent Problem:** As mentioned before, many sites (like Facebook or Amazon) will return a "403 Forbidden" if they see a Go-http-client. You often have to spoof a browser user-agent.
*   **Relative URLs:** Sometimes `og:image` is just `/logo.png`. Your code must combine that with the base URL to get `[https://example.com/logo.png](https://example.com/logo.png)`.
*   **Asynchronous Loading:** Some modern "Single Page Apps" (React/Vue) don't have these tags in the initial HTML; they are injected via JavaScript. A simple Go `http.Get` won't see them. In those cases, you would need a headless browser (like `chromedp`), though most big sites ensure their meta tags are server-side rendered for SEO.

How do you plan to display these summaries—is this for a CLI tool, a chat app, or a web dashboard?


Since you are building a **rich Markdown app for research**, a WhatsApp-style link preview (often called a "Link Card") is a major value-add. It transforms a messy URL into a structured visual reference.

In the context of a research tool, here is how you would implement that "Link Summary" logic in Go.

### 1. The Data Structure
You need a struct to hold the "Research Card" data. Beyond just the title, researchers usually need the source and a snippet.

```go
type LinkSummary struct {
    Title       string `json:"title"`
    Description string `json:"description"`
    ImageURL    string `json:"image_url"`
    SiteName    string `json:"site_name"`
    URL         string `json:"url"`
}
```

### 2. The Logic: A "Graceful Fallback" Strategy
A robust research tool shouldn't just give up if Open Graph tags are missing. You should implement a priority ladder:

1.  **Level 1: Open Graph (`og:`)** - Designed for social previews (WhatsApp/Slack style).
2.  **Level 2: Twitter Cards (`twitter:`)** - Often contains better summaries for articles.
3.  **Level 3: Standard Metadata** - `<title>` and `<meta name="description">`.
4.  **Level 4: Heuristics** - If all else fails, grab the first `<h1>` and the first `<p>` tag.

### 3. Implementation Plan
Since you've already started with the `html.Parse` logic, here is how you expand it to handle these "rich" attributes without a heavy library:

```go
func ExtractSummary(n *html.Node, summary *LinkSummary) {
    if n.Type == html.ElementNode && n.Data == "meta" {
        var property, content string
        for _, attr := range n.Attr {
            if attr.Key == "property" || attr.Key == "name" {
                property = attr.Val
            }
            if attr.Key == "content" {
                content = attr.Val
            }
        }

        // Assign based on priority
        switch property {
        case "og:title", "twitter:title":
            if summary.Title == "" { summary.Title = content }
        case "og:description", "twitter:description", "description":
            if summary.Description == "" { summary.Description = content }
        case "og:image", "twitter:image":
            if summary.ImageURL == "" { summary.ImageURL = content }
        case "og:site_name":
            summary.SiteName = content
        }
    }

    for c := n.FirstChild; c != nil; c = c.NextSibling {
        ExtractSummary(c, summary)
    }
}
```

---

### 4. Integration into a Markdown App
For a thinking/research app, you have two ways to store this in your Markdown files:

#### Option A: The "Hidden" Metadata (Front Matter)
Store the summary as a JSON block or YAML at the bottom of the file. Your UI renders the preview, but the Markdown remains clean.

#### Option B: Custom Markdown Extension
Many modern research tools (like Obsidian or Logseq) use a specific syntax for cards:
`[Title](https://url.com){: .card-preview description="..." image="..."}`

### 5. Research-Specific Enhancements
Since this is for **thinking work**, consider these two "pro" features:
*   **Archiving:** When you fetch the summary, save a local copy of the image. Links often die (link rot), but your research shouldn't.
*   **The "User-Agent" Trick:** To ensure you get the rich data, your Go client should "pretend" to be a bot that sites like:
    ```go
    req.Header.Set("User-Agent", "WhatsApp/2.21.12.21 A")
    ```
    *Sites often serve **more** metadata to WhatsApp/Slack bots than to regular browsers to ensure their links look good when shared.*

Are you planning to render these previews in real-time as the user types, or only when the document is "saved" or "viewed"?
```