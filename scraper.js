const { chromium } = require('playwright');
const axios = require('axios');
const cheerio = require('cheerio');

async function scrapeGoogleMaps(options, updateProgress) {
    const { businessType, location, useCurrentLocation, maxResults = 10 } = options;

    let searchQuery = businessType;
    if (!useCurrentLocation && location) {
        searchQuery = `${businessType} in ${location}`;
    }

    updateProgress(`Launching Playwright Browser Engine...`);

    const { chromium } = require('playwright');

    const browser = await chromium.launch({
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    });
    const context = await browser.newContext({
        permissions: useCurrentLocation ? ['geolocation'] : [],
        geolocation: useCurrentLocation ? { latitude: 24.8607, longitude: 67.0011 } : undefined
    });

    const page = await context.newPage();
    updateProgress(`Searching Google Maps: "${searchQuery}"...`);
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`, { waitUntil: 'domcontentloaded' });

    try {
        await page.waitForSelector('div[role="feed"]', { timeout: 15000 });
    } catch (e) {
        updateProgress("Could not load Google Maps results pane.");
        await browser.close();
        return [];
    }

    updateProgress(`Scrolling Google Maps feed...`);
    await page.evaluate(async () => {
        const feed = document.querySelector('div[role="feed"]');
        for (let i = 0; i < 5; i++) {
            feed.scrollBy(0, 1000);
            await new Promise(res => setTimeout(res, 1200));
        }
    });

    const listingHandles = await page.$$('div[role="feed"] > div > div[role="article"]');
    const totalFound = Math.min(listingHandles.length, maxResults);
    updateProgress(`Found listings. Extracting full business profiles for top ${totalFound}...`);

    const rawLeads = [];

    for (let i = 0; i < totalFound; i++) {
        try {
            const handles = await page.$$('div[role="feed"] > div > div[role="article"]');
            if (!handles[i]) continue;

            await handles[i].click();
            await page.waitForTimeout(2200);

            const leadData = await page.evaluate(() => {
                // Exact Shop / Business Name from Maps Panel Header
                const shopName = document.querySelector('h1.DUwif')?.innerText ||
                    document.querySelector('h1.fontHeadlineLarge')?.innerText ||
                    document.querySelector('h1')?.innerText || 'Unknown Shop';

                // Business Category / Subtitle
                const category = document.querySelector('button[jsaction*="category"]')?.innerText || 'Local Business';

                // Rating & Review Count
                const rating = document.querySelector('span.ceA1da')?.innerText || 'N/A';
                const reviews = document.querySelector('button[jsaction*="reviews"]')?.innerText.replace(/[^0-9]/g, '') || '0';

                // Native JS Search for Owner / Manager Name
                let ownerName = 'Not Listed';
                const allElements = Array.from(document.querySelectorAll('div, span, button'));
                const ownerEl = allElements.find(el => el.children.length === 0 && (el.innerText.includes('Identified as business owner') || el.innerText.includes('Owner:')));
                if (ownerEl) {
                    ownerName = ownerEl.innerText.replace(/Identified as business owner|Owner:/gi, '').trim();
                }

                // Phone Number
                const phoneBtn = document.querySelector('button[data-item-id*="phone:tel"]') ||
                    document.querySelector('button[aria-label*="Phone"]');
                const phone = phoneBtn ? phoneBtn.innerText.replace(/[^0-9+() -]/g, '').trim() : 'N/A';

                // Website Link
                const websiteBtn = document.querySelector('a[data-item-id="authority"]') ||
                    document.querySelector('a[aria-label*="Website"]');
                const website = websiteBtn ? websiteBtn.href : 'None';

                // Full Address
                const addressBtn = document.querySelector('button[data-item-id="address"]');
                const address = addressBtn ? addressBtn.innerText.replace(//g, '').trim() : 'N/A';

                // Opening Hours Status
                const hoursEl = document.querySelector('div[aria-label*="Hours"]') || document.querySelector('span[style*="color: rgb(244, 59, 46)"]');
                const openingHours = hoursEl ? hoursEl.innerText.split('\n')[0] : 'Not Specified';

                // Google Maps Direct URL
                const mapsUrl = window.location.href;

                return { shopName, category, rating, reviews, ownerName, phone, website, address, openingHours, mapsUrl };
            });

            updateProgress(`Collected profile (${i + 1}/${totalFound}): ${leadData.shopName}`);
            rawLeads.push(leadData);

        } catch (err) {
            console.error(`Error reading index ${i}:`, err.message);
        }
    }

    await browser.close();

    updateProgress(`Running automated website audits...`);
    const finalLeads = [];

    for (let i = 0; i < rawLeads.length; i++) {
        const item = rawLeads[i];
        const analysis = await auditWebsite(item.website);

        finalLeads.push({
            id: Date.now() + i,
            shopName: item.shopName,
            category: item.category,
            ownerName: item.ownerName,
            rating: item.rating,
            reviews: item.reviews,
            phone: item.phone,
            address: item.address,
            openingHours: item.openingHours,
            website: item.website,
            mapsUrl: item.mapsUrl,
            siteStatus: analysis.status,
            opportunity: analysis.opportunity,
            techStack: analysis.techStack,
            status: 'New',
            notes: ''
        });
    }

    return finalLeads;
}

async function auditWebsite(url) {
    if (!url || url === 'None') {
        return { status: 'Missing', opportunity: 'High Priority: Pitch Web Development', techStack: 'None' };
    }

    try {
        const response = await axios.get(url, { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = response.data;
        const $ = cheerio.load(html);

        const isHttp = url.startsWith('http://');
        const pageText = $('body').text();
        const hasOldFooter = /20(0[0-9]|1[0-9]|2[0-2])/.test(pageText);

        let techStack = [];
        if (html.includes('wp-content')) techStack.push('WordPress');
        if (html.includes('Shopify')) techStack.push('Shopify');
        if (html.includes('wix.com')) techStack.push('Wix');
        if (html.includes('squarespace')) techStack.push('Squarespace');

        const stackLabel = techStack.length > 0 ? techStack.join(', ') : 'Custom Web App';

        if (isHttp) {
            return { status: 'Insecure (HTTP)', opportunity: 'Pitch SSL & Security Upgrade', techStack: stackLabel };
        } else if (hasOldFooter) {
            return { status: 'Outdated Site', opportunity: 'Pitch Modern Website Redesign', techStack: stackLabel };
        } else {
            return { status: 'Modern/Active', opportunity: 'Pitch Lead Automation / WhatsApp CRM', techStack: stackLabel };
        }
    } catch (err) {
        return { status: 'Inaccessible/Broken', opportunity: 'Pitch Site Repair & Hosting Migration', techStack: 'Unknown' };
    }
}

module.exports = { scrapeGoogleMaps };