/**
 * Shared Lead Deduplication & Canonical Fingerprinting Engine
 */

/**
 * Extracts Google Maps Place identifiers from a Maps URL
 */
function extractMapsIdentifiers(url) {
    if (!url || typeof url !== 'string') return {};

    const ids = {};

    // 1. Place Hex ID: !1s0x...:0x...
    const hexMatch = url.match(/!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/);
    if (hexMatch) {
        ids.placeHex = hexMatch[1].toLowerCase();
    }

    // 2. Knowledge Graph ID: 16s%2Fg%2F... or !16s%2Fm%2F... or /g/... or /m/...
    try {
        const decoded = decodeURIComponent(url);
        const kgMatch = decoded.match(/(?:!16s|16s\/|16s%2F)(?:\/)?([0-9a-zA-Z_\/]+)/i);
        if (kgMatch) {
            const kg = kgMatch[1].replace(/^\/+/, '').split(/[?&!]/)[0].toLowerCase();
            if (kg.length >= 4) {
                ids.kgId = kg;
            }
        }
    } catch (e) {}

    // 3. CID parameter: cid=\d+
    const cidMatch = url.match(/[?&]cid=(\d+)/);
    if (cidMatch) {
        ids.cid = cidMatch[1];
    }

    // 4. Place name path: /maps/place/<name>/
    const placePathMatch = url.match(/\/maps\/place\/([^/@?]+)/);
    if (placePathMatch) {
        ids.placeNamePath = decodeURIComponent(placePathMatch[1].replace(/\+/g, ' ')).toLowerCase().trim();
    }

    return ids;
}

/**
 * Normalizes a phone number into bare digits
 */
function normalizePhone(phone) {
    if (!phone || typeof phone !== 'string') return null;
    const clean = phone.trim();
    if (clean === '' || clean === 'N/A' || clean === 'None') return null;
    
    const digits = clean.replace(/\D/g, '');
    if (digits.length < 7) return null;
    return digits;
}

/**
 * Normalizes website domain (strips protocol, www, trailing slashes, path)
 * Returns null for common platforms / social media / aggregators
 */
function normalizeWebsite(url) {
    if (!url || typeof url !== 'string') return null;
    const clean = url.trim();
    if (clean === '' || clean === 'None' || clean === 'N/A' || !clean.startsWith('http')) return null;

    try {
        const parsed = new URL(clean);
        let host = parsed.hostname.toLowerCase().replace(/^www\./, '');

        const genericDomains = [
            'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
            'linkedin.com', 'wa.me', 'whatsapp.com', 'youtube.com',
            'tiktok.com', 'pinterest.com', 'google.com', 'maps.google.com',
            'wixsite.com', 'linktr.ee', 'bit.ly'
        ];

        if (genericDomains.some(d => host === d || host.endsWith('.' + d))) {
            return null;
        }

        return host;
    } catch (e) {
        return null;
    }
}

/**
 * Normalizes text (lowercase, alphanumeric + spaces only)
 */
function normalizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Generates an array of primary and secondary fingerprint keys for a lead
 */
function getLeadFingerprints(lead) {
    if (!lead) return [];
    const fingerprints = [];

    const mapsIds = extractMapsIdentifiers(lead.mapsUrl);
    if (mapsIds.placeHex) {
        fingerprints.push(`hex:${mapsIds.placeHex}`);
    }
    if (mapsIds.kgId) {
        fingerprints.push(`kg:${mapsIds.kgId}`);
    }
    if (mapsIds.cid) {
        fingerprints.push(`cid:${mapsIds.cid}`);
    }

    const normPhone = normalizePhone(lead.phone);
    if (normPhone) {
        fingerprints.push(`phone:${normPhone}`);
        // Match on last 9 digits for country code differences (e.g. 0300... vs 92300...)
        if (normPhone.length >= 9) {
            fingerprints.push(`phone_tail:${normPhone.slice(-9)}`);
        }
    }

    const normWeb = normalizeWebsite(lead.website);
    if (normWeb) {
        fingerprints.push(`web:${normWeb}`);
    }

    const normName = normalizeText(lead.shopName);
    const normAddr = normalizeText(lead.address);

    if (normName && normName !== 'local business' && normName !== 'results') {
        if (normAddr && normAddr !== 'na' && normAddr.length >= 6) {
            // First 25 chars of address provides robust street/area matching
            fingerprints.push(`name_addr:${normName}|${normAddr.slice(0, 25)}`);
        }

        if (mapsIds.placeNamePath) {
            fingerprints.push(`name_path:${normName}|${normalizeText(mapsIds.placeNamePath)}`);
        }
    }

    return fingerprints;
}

/**
 * Checks if two lead objects represent the same business
 */
function isSameLead(a, b) {
    if (!a || !b) return false;
    if (a.id && b.id && String(a.id) === String(b.id)) return true;

    const fpsA = new Set(getLeadFingerprints(a));
    const fpsB = getLeadFingerprints(b);

    for (const fp of fpsB) {
        if (fpsA.has(fp)) return true;
    }

    // Direct name + query fallback if both lack phone/address/website
    const nameA = normalizeText(a.shopName);
    const nameB = normalizeText(b.shopName);
    if (nameA && nameB && nameA === nameB && nameA !== 'local business') {
        const queryA = normalizeText(a.searchQuery);
        const queryB = normalizeText(b.searchQuery);
        if (queryA && queryB && queryA === queryB) {
            return true;
        }
    }

    return false;
}

/**
 * Merges two lead records, keeping the most complete information
 * and preserving user-modified status / notes.
 */
function mergeLeadRecords(existingLead, newLead) {
    const isVal = (v) => v && v !== 'N/A' && v !== 'None' && v !== 'Not Listed' && v !== 'Not Specified' && v !== '{}' && v !== '';

    // Choose the richer values
    const phone = isVal(newLead.phone) ? newLead.phone : existingLead.phone;
    const email = isVal(newLead.email) ? newLead.email : existingLead.email;
    const address = isVal(newLead.address) ? newLead.address : existingLead.address;
    const website = isVal(newLead.website) ? newLead.website : existingLead.website;
    const ownerName = isVal(newLead.ownerName) ? newLead.ownerName : existingLead.ownerName;
    const rating = isVal(newLead.rating) ? newLead.rating : existingLead.rating;
    const reviews = (parseInt(newLead.reviews, 10) || 0) >= (parseInt(existingLead.reviews, 10) || 0) ? newLead.reviews : existingLead.reviews;
    const techStack = isVal(newLead.techStack) ? newLead.techStack : existingLead.techStack;
    const siteStatus = isVal(newLead.siteStatus) ? newLead.siteStatus : existingLead.siteStatus;
    const opportunity = isVal(newLead.opportunity) ? newLead.opportunity : existingLead.opportunity;
    const socials = isVal(newLead.socials) ? newLead.socials : existingLead.socials;
    const mapsUrl = (newLead.mapsUrl && newLead.mapsUrl.includes('place')) ? newLead.mapsUrl : existingLead.mapsUrl;

    // Preserve user status & notes if customized
    const status = (existingLead.status && existingLead.status !== 'New') ? existingLead.status : (newLead.status || existingLead.status || 'New');
    const notes = existingLead.notes ? existingLead.notes : (newLead.notes || '');

    return {
        ...existingLead,
        ...newLead,
        id: existingLead.id || newLead.id,
        phone,
        email,
        address,
        website,
        ownerName,
        rating,
        reviews,
        techStack,
        siteStatus,
        opportunity,
        socials,
        mapsUrl,
        status,
        notes,
        createdAt: existingLead.createdAt || newLead.createdAt || new Date().toISOString()
    };
}

/**
 * Deduplicates an array of leads, merging duplicate records into canonical leads
 */
function deduplicateLeads(leads) {
    if (!Array.isArray(leads) || leads.length === 0) return [];

    const canonicalList = [];
    const fingerprintToIdx = new Map();

    for (const lead of leads) {
        const fingerprints = getLeadFingerprints(lead);
        let matchedIdx = -1;

        for (const fp of fingerprints) {
            if (fingerprintToIdx.has(fp)) {
                matchedIdx = fingerprintToIdx.get(fp);
                break;
            }
        }

        // Secondary check: name + query fallback
        if (matchedIdx === -1) {
            const normName = normalizeText(lead.shopName);
            const normQuery = normalizeText(lead.searchQuery);
            if (normName && normName !== 'local business') {
                const nameQueryKey = `nq:${normName}|${normQuery}`;
                if (fingerprintToIdx.has(nameQueryKey)) {
                    matchedIdx = fingerprintToIdx.get(nameQueryKey);
                }
            }
        }

        if (matchedIdx !== -1) {
            // Merge with existing canonical lead
            canonicalList[matchedIdx] = mergeLeadRecords(canonicalList[matchedIdx], lead);
            // Re-index any new fingerprints from the merged lead
            const updatedFps = getLeadFingerprints(canonicalList[matchedIdx]);
            for (const fp of updatedFps) {
                fingerprintToIdx.set(fp, matchedIdx);
            }
        } else {
            // New canonical lead
            const newIdx = canonicalList.length;
            canonicalList.push(lead);

            for (const fp of fingerprints) {
                fingerprintToIdx.set(fp, newIdx);
            }

            const normName = normalizeText(lead.shopName);
            const normQuery = normalizeText(lead.searchQuery);
            if (normName && normName !== 'local business') {
                fingerprintToIdx.set(`nq:${normName}|${normQuery}`, newIdx);
            }
        }
    }

    return canonicalList;
}

module.exports = {
    extractMapsIdentifiers,
    normalizePhone,
    normalizeWebsite,
    normalizeText,
    getLeadFingerprints,
    isSameLead,
    mergeLeadRecords,
    deduplicateLeads
};
