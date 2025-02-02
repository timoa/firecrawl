import axios, { AxiosError } from "axios";
import cheerio, { load } from "cheerio";
import { URL } from "url";
import { getLinksFromSitemap } from "./sitemap";
import robotsParser from "robots-parser";
import { getURLDepth } from "./utils/maxDepthUtils";
import { axiosTimeout } from "../../../src/lib/timeout";
import { logger } from "../../../src/lib/logger";
import https from "https";
export class WebCrawler {
  private jobId: string;
  private initialUrl: string;
  private baseUrl: string;
  private includes: string[];
  private excludes: string[];
  private maxCrawledLinks: number;
  private maxCrawledDepth: number;
  private visited: Set<string> = new Set();
  private crawledUrls: Map<string, string> = new Map();
  private limit: number;
  private robotsTxtUrl: string;
  public robots: any;
  private generateImgAltText: boolean;
  private allowBackwardCrawling: boolean;
  private allowExternalContentLinks: boolean;

  constructor({
    jobId,
    initialUrl,
    includes,
    excludes,
    maxCrawledLinks = 10000,
    limit = 10000,
    generateImgAltText = false,
    maxCrawledDepth = 10,
    allowBackwardCrawling = false,
    allowExternalContentLinks = false
  }: {
    jobId: string;
    initialUrl: string;
    includes?: string[];
    excludes?: string[];
    maxCrawledLinks?: number;
    limit?: number;
    generateImgAltText?: boolean;
    maxCrawledDepth?: number;
    allowBackwardCrawling?: boolean;
    allowExternalContentLinks?: boolean;
  }) {
    this.jobId = jobId;
    this.initialUrl = initialUrl;
    this.baseUrl = new URL(initialUrl).origin;
    this.includes = Array.isArray(includes) ? includes : [];
    this.excludes = Array.isArray(excludes) ? excludes : [];
    this.limit = limit;
    this.robotsTxtUrl = `${this.baseUrl}/robots.txt`;
    this.robots = robotsParser(this.robotsTxtUrl, "");
    // Deprecated, use limit instead
    this.maxCrawledLinks = maxCrawledLinks ?? limit;
    this.maxCrawledDepth = maxCrawledDepth ?? 10;
    this.generateImgAltText = generateImgAltText ?? false;
    this.allowBackwardCrawling = allowBackwardCrawling ?? false;
    this.allowExternalContentLinks = allowExternalContentLinks ?? false;
  }

  public filterLinks(sitemapLinks: string[], limit: number, maxDepth: number): string[] {
    return sitemapLinks
      .filter((link) => {
        let url: URL;
        try {
          url = new URL(link.trim(), this.baseUrl);
        } catch (error) {
          logger.debug(`Error processing link: ${link} | Error: ${error.message}`);
          return false;
        }
        const path = url.pathname;
        
        const depth = getURLDepth(url.toString());

        
        // Check if the link exceeds the maximum depth allowed
        if (depth > maxDepth) {
          return false;
        }

        // Check if the link should be excluded
        if (this.excludes.length > 0 && this.excludes[0] !== "") {
          if (
            this.excludes.some((excludePattern) =>
              new RegExp(excludePattern).test(path)
            )
          ) {
            return false;
          }
        }

        // Check if the link matches the include patterns, if any are specified
        if (this.includes.length > 0 && this.includes[0] !== "") {
          if (!this.includes.some((includePattern) =>
            new RegExp(includePattern).test(path)
          )) {
            return false;
          }
        }

        // Normalize the initial URL and the link to account for www and non-www versions
        const normalizedInitialUrl = new URL(this.initialUrl);
        let normalizedLink;
        try {
          normalizedLink = new URL(link);
        } catch (_) {
          return false;
        }
        const initialHostname = normalizedInitialUrl.hostname.replace(/^www\./, '');
        const linkHostname = normalizedLink.hostname.replace(/^www\./, '');

        // Ensure the protocol and hostname match, and the path starts with the initial URL's path
        // commented to able to handling external link on allowExternalContentLinks
        // if (linkHostname !== initialHostname) {
        //   return false;
        // }

        if (!this.allowBackwardCrawling) {
          if (!normalizedLink.pathname.startsWith(normalizedInitialUrl.pathname)) {
            return false;
          }
        }

        const isAllowed = this.robots.isAllowed(link, "FireCrawlAgent") ?? true;
        // Check if the link is disallowed by robots.txt
        if (!isAllowed) {
          logger.debug(`Link disallowed by robots.txt: ${link}`);
          return false;
        }

        if (this.isFile(link)) {
          return false;
        }

        return true;
      })
      .slice(0, limit);
  }

  public async getRobotsTxt(skipTlsVerification = false): Promise<string> {
    let extraArgs = {};
    if(skipTlsVerification) {
      extraArgs["httpsAgent"] = new https.Agent({
        rejectUnauthorized: false
      });
    }
    const response = await axios.get(this.robotsTxtUrl, { timeout: axiosTimeout, ...extraArgs });
    return response.data;
  }

  public importRobotsTxt(txt: string) {
    this.robots = robotsParser(this.robotsTxtUrl, txt);
  }

  public async tryGetSitemap(): Promise<{ url: string; html: string; }[] | null> {
    logger.debug(`Fetching sitemap links from ${this.initialUrl}`);
    const sitemapLinks = await this.tryFetchSitemapLinks(this.initialUrl);
    if (sitemapLinks.length > 0) {
      let filteredLinks = this.filterLinks(sitemapLinks, this.limit, this.maxCrawledDepth);
      return filteredLinks.map(link => ({ url: link, html: "" }));
    }
    return null;
  }

  public filterURL(href: string, url: string): string | null {
    let fullUrl = href;
    if (!href.startsWith("http")) {
      try {
        fullUrl = new URL(href, this.baseUrl).toString();
      } catch (_) {
        return null;
      }
    }
    let urlObj;
    try {
      urlObj = new URL(fullUrl);
    } catch (_) {
      return null;
    }
    const path = urlObj.pathname;

    if (this.isInternalLink(fullUrl)) { // INTERNAL LINKS
      if (this.isInternalLink(fullUrl) &&
        this.noSections(fullUrl) &&
        !this.matchesExcludes(path) &&
        this.isRobotsAllowed(fullUrl)
      ) {
        return fullUrl;
      }
    } else { // EXTERNAL LINKS
      if (
        this.isInternalLink(url) &&
        this.allowExternalContentLinks &&
        !this.isSocialMediaOrEmail(fullUrl) &&
        !this.matchesExcludes(fullUrl, true) &&
        !this.isExternalMainPage(fullUrl)
      ) {
        return fullUrl;
      }
    }

    return null;
  }

  public extractLinksFromHTML(html: string, url: string) {
    let links: string[] = [];

    const $ = load(html);
    $("a").each((_, element) => {
      const href = $(element).attr("href");
      if (href) {
        const u = this.filterURL(href, url);
        if (u !== null) {
          links.push(u);
        }
      }
    });

    // Extract links from iframes with inline src
    $("iframe").each((_, element) => {
      const src = $(element).attr("src");
      if (src && src.startsWith("data:text/html")) {
        const iframeHtml = decodeURIComponent(src.split(",")[1]);
        const iframeLinks = this.extractLinksFromHTML(iframeHtml, url);
        links = links.concat(iframeLinks);
      }
    });

    return links;
  }

  private isRobotsAllowed(url: string): boolean {
    return (this.robots ? (this.robots.isAllowed(url, "FireCrawlAgent") ?? true) : true)
  }

  private matchesExcludes(url: string, onlyDomains: boolean = false): boolean {
    return this.excludes.some((pattern) => {
      if (onlyDomains)
        return this.matchesExcludesExternalDomains(url);

      return this.excludes.some((pattern) => new RegExp(pattern).test(url));
    });
  }

  // supported formats: "example.com/blog", "https://example.com", "blog.example.com", "example.com"
  private matchesExcludesExternalDomains(url: string) {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;
      const pathname = urlObj.pathname;

      for (let domain of this.excludes) {
        let domainObj = new URL('http://' + domain.replace(/^https?:\/\//, ''));
        let domainHostname = domainObj.hostname;
        let domainPathname = domainObj.pathname;

        if (hostname === domainHostname || hostname.endsWith(`.${domainHostname}`)) {
          if (pathname.startsWith(domainPathname)) {
            return true;
          }
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  private isExternalMainPage(url:string):boolean {
    return !Boolean(url.split("/").slice(3).filter(subArray => subArray.length > 0).length)
  }

  private noSections(link: string): boolean {
    return !link.includes("#");
  }

  private isInternalLink(link: string): boolean {
    const urlObj = new URL(link, this.baseUrl);
    const baseDomain = this.baseUrl.replace(/^https?:\/\//, "").replace(/^www\./, "").trim();
    const linkDomain = urlObj.hostname.replace(/^www\./, "").trim();
    
    return linkDomain === baseDomain;
  }

  public isFile(url: string): boolean {
    const fileExtensions = [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".css",
      ".js",
      ".ico",
      ".svg",
      ".tiff",
      // ".pdf", 
      ".zip",
      ".exe",
      ".dmg",
      ".mp4",
      ".mp3",
      ".pptx",
      // ".docx",
      ".xlsx",
      ".xml",
      ".avi",
      ".flv",
      ".woff",
      ".ttf",
      ".woff2",
      ".webp",
      ".inc"
    ];

    try {
      const urlWithoutQuery = url.split('?')[0].toLowerCase();
      return fileExtensions.some((ext) => urlWithoutQuery.endsWith(ext));
    } catch (error) {
      logger.error(`Error processing URL in isFile: ${error}`);
      return false;
    }
  }

  private isSocialMediaOrEmail(url: string): boolean {
    const socialMediaOrEmail = [
      "facebook.com",
      "twitter.com",
      "linkedin.com",
      "instagram.com",
      "pinterest.com",
      "mailto:",
      "github.com",
      "calendly.com",
      "discord.gg",
      "discord.com",
    ];
    return socialMediaOrEmail.some((ext) => url.includes(ext));
  }

  private async tryFetchSitemapLinks(url: string): Promise<string[]> {
    const normalizeUrl = (url: string) => {
      url = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
      if (url.endsWith("/")) {
        url = url.slice(0, -1);
      }
      return url;
    };

    const sitemapUrl = url.endsWith("/sitemap.xml")
      ? url
      : `${url}/sitemap.xml`;

    let sitemapLinks: string[] = [];

    try {
      const response = await axios.get(sitemapUrl, { timeout: axiosTimeout });
      if (response.status === 200) {
        sitemapLinks = await getLinksFromSitemap({ sitemapUrl });
      }
    } catch (error) { 
      logger.debug(`Failed to fetch sitemap with axios from ${sitemapUrl}: ${error}`);
      if (error instanceof AxiosError && error.response?.status === 404) {
        // ignore 404
      } else {
        const response = await getLinksFromSitemap({ sitemapUrl, mode: 'fire-engine' });
        if (response) {
          sitemapLinks = response;
        }
      }
    }

    if (sitemapLinks.length === 0) {
      const baseUrlSitemap = `${this.baseUrl}/sitemap.xml`;
      try {
        const response = await axios.get(baseUrlSitemap, { timeout: axiosTimeout });
        if (response.status === 200) {
          sitemapLinks = await getLinksFromSitemap({ sitemapUrl: baseUrlSitemap, mode: 'fire-engine' });
        }
      } catch (error) {
        logger.debug(`Failed to fetch sitemap from ${baseUrlSitemap}: ${error}`);
        if (error instanceof AxiosError && error.response?.status === 404) {
          // ignore 404
        } else {
          sitemapLinks = await getLinksFromSitemap({ sitemapUrl: baseUrlSitemap, mode: 'fire-engine' });
        }
      }
    }

    const normalizedUrl = normalizeUrl(url);
    const normalizedSitemapLinks = sitemapLinks.map(link => normalizeUrl(link));
    // has to be greater than 0 to avoid adding the initial URL to the sitemap links, and preventing crawler to crawl
    if (!normalizedSitemapLinks.includes(normalizedUrl) && sitemapLinks.length > 0) {
      sitemapLinks.push(url);
    }
    return sitemapLinks;
  }
}
