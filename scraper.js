const { chromium } = require('playwright');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

/**
 * Launch Playwright Chromium with graceful fallback
 */
async function launchBrowser() {
    const chromePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : ''
    ].filter(Boolean);

    for (const p of chromePaths) {
        if (fs.existsSync(p)) {
            try {
                return await chromium.launch({
                    executablePath: p,
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
                });
            } catch (e) {
                console.warn(`Could not launch Chrome from ${p}, falling back...`);
            }
        }
    }

    // Default bundled Chromium fallback
    return await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
}

/**
 * Clean Map Glyphs and Formatting
 */
function sanitizeText(str) {
    if (!str) return '';
    return str
        .replace(/[\uE000-\uF8FF]/g, '')
        .replace(/[]/g, '')
        .replace(/\r?\n+/g, ', ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * Validates whether an extracted string is a legitimate human name
 */
function isValidHumanName(name) {
    if (!name || typeof name !== 'string') return false;
    const clean = name.trim().replace(/^(dr\.|dr|mr\.|mr|mrs\.|ms\.)\s+/i, '');
    if (clean.length < 3 || clean.length > 40) return false;
    const words = clean.split(/\s+/);
    if (words.length < 2 || words.length > 4) return false;

    const stopWords = new Set([
        'new', 'york', 'united', 'states', 'street', 'avenue', 'boulevard', 'road',
        'city', 'county', 'center', 'clinic', 'store', 'shop', 'services', 'service',
        'company', 'group', 'corporation', 'inc', 'llc', 'ltd', 'dental', 'medical',
        'legal', 'bakery', 'restaurant', 'salon', 'boutique', 'market', 'hotel',
        'privacy', 'policy', 'terms', 'conditions', 'about', 'contact', 'home',
        'read', 'more', 'view', 'all', 'our', 'team', 'welcome', 'phone', 'email',
        'business', 'hours', 'monday', 'friday', 'sunday', 'saturday', 'and', 'the',
        'board', 'certified', 'general', 'family', 'specialist', 'practice'
    ]);

    for (const w of words) {
        const low = w.toLowerCase().replace(/[^a-z]/g, '');
        if (stopWords.has(low)) return false;
        if (!/^[A-Z]/.test(w)) return false;
    }

    return true;
}

/**
 * Extracts Owner / Founder / Leadership name from Website HTML
 */
function extractOwnerFromHtml(html) {
    if (!html || typeof html !== 'string') return null;
    const $ = cheerio.load(html);

    // 1. Check Schema.org / JSON-LD structured data
    const scripts = $('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length; i++) {
        try {
            const rawContent = $(scripts[i]).html();
            if (!rawContent) continue;
            const data = JSON.parse(rawContent);

            const checkObject = (obj) => {
                if (!obj || typeof obj !== 'object') return null;
                if (obj['@type'] === 'Person' && typeof obj.name === 'string') return obj.name.trim();
                if (obj.founder) {
                    if (typeof obj.founder === 'string') return obj.founder.trim();
                    if (obj.founder.name) return String(obj.founder.name).trim();
                }
                if (obj.founder && Array.isArray(obj.founder) && obj.founder[0]?.name) return String(obj.founder[0].name).trim();
                if (obj.employee && Array.isArray(obj.employee) && obj.employee[0]?.name) return String(obj.employee[0].name).trim();
                if (obj.author && typeof obj.author === 'object' && obj.author.name) return String(obj.author.name).trim();
                
                for (const key of Object.keys(obj)) {
                    if (typeof obj[key] === 'object') {
                        const nested = checkObject(obj[key]);
                        if (nested) return nested;
                    }
                }
                return null;
            };

            const person = checkObject(data);
            if (person && isValidHumanName(person)) return person;
        } catch (e) {}
    }

    // 2. Check Team / Leadership DOM cards with role headings
    const roleRegex = /\b(founder|co-founder|owner|ceo|president|managing director|managing partner|principal|lead dentist|dentist|chiropractor|attorney|head chef|proprietor|founder & owner|owner & founder)\b/i;
    let detectedFromDom = null;

    $('[class*="team"], [class*="about"], [class*="leader"], [class*="staff"], [class*="bio"], [class*="member"], [class*="doctor"], [class*="profile"], [class*="attorney"]').each((_, el) => {
        if (detectedFromDom) return;
        const blockText = $(el).text();
        if (roleRegex.test(blockText)) {
            $(el).find('h1, h2, h3, h4, h5, strong, [class*="name"], [class*="title"]').each((_, headEl) => {
                if (detectedFromDom) return;
                const candidate = $(headEl).text().trim().replace(/^(dr\.|dr|mr\.|mr|mrs\.|ms\.)\s+/i, '');
                if (isValidHumanName(candidate)) {
                    detectedFromDom = candidate;
                }
            });
        }
    });

    if (detectedFromDom) return detectedFromDom;

    // 3. Fallback: Contextual Text Regex on clean body text
    const bodyText = $('body').text().replace(/\s+/g, ' ');

    const regexRules = [
        /(?:founded by|co-founder|founder)\s*[:–-]?\s*([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)/i,
        /([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)\s*[,–-]\s*(?:owner|founder|co-founder|ceo|president|managing partner|principal|lead dentist|proprietor)/i,
        /(?:owner & founder|founder & owner|owner|proprietor)\s*[:–-]?\s*([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)/i,
        /(?:meet our founder|meet the founder|meet the owner|meet)\s+([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)/i,
        /(?:Dr\.|Attorney)\s+([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)/i
    ];

    for (const rule of regexRules) {
        const match = bodyText.match(rule);
        if (match && match[1] && isValidHumanName(match[1].trim())) {
            return match[1].trim();
        }
    }

    return null;
}

/**
 * Extracts emails from HTML
 */
function extractEmailsFromHtml(html) {
    if (!html) return [];
    const $ = cheerio.load(html);
    const foundEmails = new Set();
    
    // Mailto links
    $('a[href^="mailto:"]').each((_, el) => {
        const mail = $(el).attr('href').replace(/^mailto:/i, '').split('?')[0].trim();
        if (mail && mail.includes('@')) foundEmails.add(mail.toLowerCase());
    });

    // Body Text Regex
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const matches = html.match(emailRegex) || [];
    const junkExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif', '.css', '.js'];
    const junkDomains = ['sentry.io', 'wixpress.com', 'schema.org', 'example.com', 'domain.com', 'email.com', 'w3.org'];

    matches.forEach(email => {
        const lower = email.toLowerCase();
        const hasJunkExt = junkExtensions.some(ext => lower.endsWith(ext));
        const hasJunkDomain = junkDomains.some(d => lower.includes(d));
        if (!hasJunkExt && !hasJunkDomain) {
            foundEmails.add(lower);
        }
    });

    return Array.from(foundEmails);
}

/**
 * Fallback name inference from Business / Shop Name
 */
function inferOwnerFromShopName(shopName) {
    if (!shopName) return null;
    
    // Dr. [First] [Last]
    const drMatch = shopName.match(/(?:Dr\.|Doctor)\s+([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)/i);
    if (drMatch && isValidHumanName(drMatch[1])) return drMatch[1];

    // Law Office(s) of [First] [Last]
    const lawMatch = shopName.match(/Law\s+(?:Office|Offices|Group|Firm)\s+of\s+([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)/i);
    if (lawMatch && isValidHumanName(lawMatch[1])) return lawMatch[1];

    // [First] [Last], CPA / MD / DDS
    const degreeMatch = shopName.match(/^([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)(?:,\s*(?:CPA|MD|DDS|DMD|DC|Esq|LLC))?/);
    if (degreeMatch && isValidHumanName(degreeMatch[1])) return degreeMatch[1];

    return null;
}

/**
 * Deep website audit with email, owner & social profile scraping
 */
async function auditWebsite(url, shopName = '') {
    const defaultSocials = { instagram: '', facebook: '', linkedin: '', twitter: '', whatsapp: '' };

    if (!url || url === 'None' || !url.startsWith('http')) {
        const shopInferred = inferOwnerFromShopName(shopName);
        return {
            status: 'Missing',
            opportunity: 'High Priority: Pitch Web Development & Brand Presence',
            techStack: 'None',
            email: 'None',
            ownerName: shopInferred || 'Not Listed',
            socials: defaultSocials
        };
    }

    try {
        const response = await axios.get(url, {
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            maxRedirects: 5,
            validateStatus: (status) => status < 500
        });

        const html = typeof response.data === 'string' ? response.data : '';
        const $ = cheerio.load(html);

        // 1. Email Extraction from Homepage
        let foundEmails = extractEmailsFromHtml(html);

        // 2. Owner Extraction from Homepage
        let detectedOwner = extractOwnerFromHtml(html);

        // 3. Social Media Links Extraction
        const socials = { ...defaultSocials };
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href') || '';
            if (href.includes('instagram.com/') && !href.includes('instagram.com/p/') && !socials.instagram) {
                socials.instagram = href;
            } else if (href.includes('facebook.com/') && !href.includes('sharer') && !socials.facebook) {
                socials.facebook = href;
            } else if (href.includes('linkedin.com/') && !socials.linkedin) {
                socials.linkedin = href;
            } else if ((href.includes('twitter.com/') || href.includes('x.com/')) && !socials.twitter) {
                socials.twitter = href;
            } else if ((href.includes('wa.me/') || href.includes('api.whatsapp.com/send')) && !socials.whatsapp) {
                socials.whatsapp = href;
            }
        });

        // 4. Subpage Crawl for Team / About / Contact if owner or email is missing
        if (!detectedOwner || foundEmails.length === 0) {
            const aboutLinks = [];
            $('a[href]').each((_, el) => {
                const href = $(el).attr('href') || '';
                const text = $(el).text().toLowerCase();
                if (/about|team|leadership|who-we-are|founder|doctors|attorney|staff|contact/i.test(href) ||
                    /about us|our team|meet the team|leadership|doctors|contact us/i.test(text)) {
                    try {
                        const fullUrl = new URL(href, url).href;
                        if (fullUrl.startsWith(new URL(url).origin) && !aboutLinks.includes(fullUrl)) {
                            aboutLinks.push(fullUrl);
                        }
                    } catch (e) {}
                }
            });

            if (aboutLinks.length > 0) {
                try {
                    const subRes = await axios.get(aboutLinks[0], {
                        timeout: 5000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                        },
                        validateStatus: (s) => s < 500
                    });
                    const subHtml = typeof subRes.data === 'string' ? subRes.data : '';
                    if (subHtml) {
                        if (!detectedOwner) detectedOwner = extractOwnerFromHtml(subHtml);
                        if (foundEmails.length === 0) {
                            const subEmails = extractEmailsFromHtml(subHtml);
                            foundEmails = [...foundEmails, ...subEmails];
                        }
                    }
                } catch (e) {}
            }
        }

        // 5. Final fallback from shop name
        if (!detectedOwner) {
            detectedOwner = inferOwnerFromShopName(shopName);
        }

        // 6. Tech Stack Detection
        const techStack = [];
        if (html.includes('wp-content') || html.includes('wp-includes')) techStack.push('WordPress');
        if (html.includes('Shopify') || html.includes('cdn.shopify.com')) techStack.push('Shopify');
        if (html.includes('wix.com') || html.includes('_wix')) techStack.push('Wix');
        if (html.includes('squarespace')) techStack.push('Squarespace');
        if (html.includes('webflow')) techStack.push('Webflow');
        if (html.includes('woocommerce')) techStack.push('WooCommerce');
        if (html.includes('__NEXT_DATA__') || html.includes('react')) techStack.push('React / Next.js');

        const stackLabel = techStack.length > 0 ? techStack.join(', ') : 'Custom Web App';

        // 7. Status Evaluation
        const isHttp = url.startsWith('http://');
        const pageText = $('body').text();
        const hasOldFooter = /©\s*20(0[0-9]|1[0-9]|2[0-3])/.test(pageText);

        const emailResult = foundEmails.length > 0 ? foundEmails[0] : 'None';

        if (isHttp) {
            return {
                status: 'Insecure (HTTP)',
                opportunity: 'Pitch SSL Security & Mobile Speed Upgrade',
                techStack: stackLabel,
                email: emailResult,
                ownerName: detectedOwner || 'Not Listed',
                socials
            };
        } else if (hasOldFooter) {
            return {
                status: 'Outdated Site',
                opportunity: 'Pitch Modern Website Redesign & Lead Capture',
                techStack: stackLabel,
                email: emailResult,
                ownerName: detectedOwner || 'Not Listed',
                socials
            };
        } else {
            return {
                status: 'Modern/Active',
                opportunity: 'Pitch WhatsApp CRM & AI Chatbot Automation',
                techStack: stackLabel,
                email: emailResult,
                ownerName: detectedOwner || 'Not Listed',
                socials
            };
        }
    } catch (err) {
        const shopInferred = inferOwnerFromShopName(shopName);
        return {
            status: 'Inaccessible/Broken',
            opportunity: 'Pitch Site Repair & Cloud Hosting Migration',
            techStack: 'Unknown',
            email: 'None',
            ownerName: shopInferred || 'Not Listed',
            socials: defaultSocials
        };
    }
}

/**
 * Main Google Maps Scraping Function
 */
async function scrapeGoogleMaps(options, updateProgress, onLeadScraped) {
    const { businessType, location, useCurrentLocation, maxResults = 10 } = options;

    let searchQuery = businessType;
    if (!useCurrentLocation && location) {
        searchQuery = `${businessType} in ${location}`;
    }

    updateProgress(`Launching browser engine...`);
    const browser = await launchBrowser();
    const context = await browser.newContext({
        permissions: useCurrentLocation ? ['geolocation'] : [],
        geolocation: useCurrentLocation ? { latitude: 40.7128, longitude: -74.0060 } : undefined,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    updateProgress(`Searching Google Maps for "${searchQuery}"...`);

    const targetUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    try {
        await page.waitForSelector('div[role="feed"]', { timeout: 15000 });
    } catch (e) {
        updateProgress("Could not load Google Maps results pane. Checking for direct place redirect...");
        const isSinglePlace = await page.$('h1.DUwif, h1.fontHeadlineLarge');
        if (!isSinglePlace) {
            await browser.close();
            return [];
        }
    }

    updateProgress(`Scanning Google Maps feed...`);

    // Auto-scroll feed dynamically based on requested results
    const scrollIterations = Math.min(Math.ceil(maxResults / 3), 8);
    for (let i = 0; i < scrollIterations; i++) {
        await page.evaluate(() => {
            const feed = document.querySelector('div[role="feed"]');
            if (feed) feed.scrollBy(0, 1500);
        });
        await page.waitForTimeout(1000);
    }

    const listingHandles = await page.$$('div[role="feed"] > div > div[role="article"]');
    const totalFound = Math.min(listingHandles.length, maxResults);

    if (totalFound === 0) {
        updateProgress(`No listings found for query "${searchQuery}".`);
        await browser.close();
        return [];
    }

    updateProgress(`Found listings. Extracting profiles & website leadership for ${totalFound} businesses...`);

    const processedLeads = [];

    for (let i = 0; i < totalFound; i++) {
        try {
            const handles = await page.$$('div[role="feed"] > div > div[role="article"]');
            if (!handles[i]) continue;

            const cardFallback = await handles[i].evaluate(el => {
                const label = el.getAttribute('aria-label');
                if (label) return label.trim();
                const heading = el.querySelector('div.fontHeadlineSmall, div.qBF1Pd, h2, h3');
                return heading ? heading.innerText.trim() : '';
            });

            await handles[i].click();
            await page.waitForTimeout(1800);

            const leadData = await page.evaluate((fallbackName) => {
                let shopName = '';
                const mainHeader = document.querySelector('h1.DUwif') ||
                    document.querySelector('div.TIHn2 h1') ||
                    document.querySelector('h1.fontHeadlineLarge') ||
                    document.querySelector('div.lMbq3e h1');

                if (mainHeader && mainHeader.innerText && mainHeader.innerText.trim() !== 'Results') {
                    shopName = mainHeader.innerText.trim();
                } else if (fallbackName && fallbackName !== 'Results') {
                    shopName = fallbackName;
                } else {
                    shopName = 'Local Business';
                }

                const catEl = document.querySelector('button[jsaction*="category"]') ||
                    document.querySelector('span.DkEaL');
                const category = catEl ? catEl.innerText.trim() : 'Local Business';

                const ratingEl = document.querySelector('span.ceA1da') ||
                    document.querySelector('div.F7nice span[aria-hidden="true"]');
                const rating = ratingEl ? ratingEl.innerText.trim() : 'N/A';

                const reviewsEl = document.querySelector('button[jsaction*="reviews"]') ||
                    document.querySelector('div.F7nice span[aria-label*="reviews"]');
                const reviews = reviewsEl ? reviewsEl.innerText.replace(/[^0-9]/g, '') : '0';

                // Maps DOM Owner search
                let ownerName = 'Not Listed';
                const allElements = Array.from(document.querySelectorAll('div, span, button'));
                const ownerEl = allElements.find(el => el.children.length === 0 && (el.innerText.includes('Identified as business owner') || el.innerText.includes('Owner:')));
                if (ownerEl) {
                    ownerName = ownerEl.innerText.replace(/Identified as business owner|Owner:/gi, '').trim();
                }

                const phoneBtn = document.querySelector('button[data-item-id*="phone:tel"]') ||
                    document.querySelector('button[aria-label*="Phone"]');
                const phone = phoneBtn ? phoneBtn.innerText.replace(/[^0-9+() -]/g, '').trim() : 'N/A';

                const websiteBtn = document.querySelector('a[data-item-id="authority"]') ||
                    document.querySelector('a[aria-label*="Website"]');
                const website = websiteBtn ? websiteBtn.href : 'None';

                const addressBtn = document.querySelector('button[data-item-id="address"]') ||
                    document.querySelector('button[aria-label*="Address"]');
                const rawAddress = addressBtn ? addressBtn.innerText : 'N/A';

                const hoursEl = document.querySelector('div[aria-label*="Hours"]') ||
                    document.querySelector('button[data-item-id*="oh"]') ||
                    document.querySelector('span[style*="color: rgb(244, 59, 46)"]');
                const openingHours = hoursEl ? hoursEl.innerText.split('\n')[0] : 'Not Specified';

                const mapsUrl = window.location.href;

                return { shopName, category, rating, reviews, ownerName, phone, website, rawAddress, openingHours, mapsUrl };
            }, cardFallback);

            const address = sanitizeText(leadData.rawAddress);
            updateProgress(`Auditing website & leadership (${i + 1}/${totalFound}): ${leadData.shopName}...`);

            // Run deep website audit (emails, owner, socials, tech stack, opportunity)
            const audit = await auditWebsite(leadData.website, leadData.shopName);

            const finalOwner = (leadData.ownerName && leadData.ownerName !== 'Not Listed')
                ? leadData.ownerName
                : (audit.ownerName || 'Not Listed');

            const completeLead = {
                id: Date.now() + i,
                shopName: leadData.shopName,
                category: leadData.category,
                ownerName: finalOwner,
                rating: leadData.rating,
                reviews: leadData.reviews || '0',
                phone: leadData.phone,
                email: audit.email || 'None',
                socials: JSON.stringify(audit.socials || {}),
                address: address || 'N/A',
                openingHours: leadData.openingHours,
                website: leadData.website,
                mapsUrl: leadData.mapsUrl,
                siteStatus: audit.status,
                opportunity: audit.opportunity,
                techStack: audit.techStack,
                searchQuery: searchQuery,
                status: 'New',
                notes: '',
                createdAt: new Date().toISOString()
            };

            processedLeads.push(completeLead);

            if (typeof onLeadScraped === 'function') {
                onLeadScraped(completeLead);
            }

        } catch (err) {
            console.error(`Error reading index ${i}:`, err.message);
        }
    }

    await browser.close();
    updateProgress(`Completed scrape for "${searchQuery}". Total extracted: ${processedLeads.length}`);
    return processedLeads;
}

module.exports = { scrapeGoogleMaps, auditWebsite, extractOwnerFromHtml, extractEmailsFromHtml, isValidHumanName, sanitizeText };