const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const csvParser = require('csv-parser');
const { Parser } = require('json2csv');
const { scrapeGoogleMaps } = require('./scraper');
const { deduplicateLeads, isSameLead, mergeLeadRecords } = require('./dedupe');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const CSV_FILE = process.env.VERCEL ? path.join('/tmp', 'leads.csv') : path.join(__dirname, 'leads.csv');

function initVercelStorage() {
    if (process.env.VERCEL) {
        const bundledCSV = path.join(__dirname, 'leads.csv');
        if (!fs.existsSync(CSV_FILE) && fs.existsSync(bundledCSV)) {
            try {
                fs.copyFileSync(bundledCSV, CSV_FILE);
            } catch (err) {
                console.error('Error copying initial leads to /tmp:', err);
            }
        }
    }
}
initVercelStorage();

const CSV_FIELDS = [
    'id',
    'shopName',
    'category',
    'ownerName',
    'rating',
    'reviews',
    'phone',
    'email',
    'socials',
    'address',
    'openingHours',
    'website',
    'mapsUrl',
    'siteStatus',
    'opportunity',
    'techStack',
    'searchQuery',
    'status',
    'notes',
    'createdAt'
];

app.use(express.json());
app.use(express.static(__dirname));

// Explicit Root Route for Vercel Serverless
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Helper: Read and Normalize CSV
function readLeads() {
    return new Promise((resolve) => {
        let targetFile = CSV_FILE;
        if (!fs.existsSync(targetFile)) {
            const bundledCSV = path.join(__dirname, 'leads.csv');
            if (fs.existsSync(bundledCSV)) {
                targetFile = bundledCSV;
            } else {
                return resolve([]);
            }
        }
        const leads = [];
        fs.createReadStream(targetFile)
            .pipe(csvParser())
            .on('data', (raw) => {
                // Normalize and handle legacy field names
                const shopName = raw.shopName || raw.name || 'Local Business';
                if (!shopName || shopName.trim() === '') return;

                leads.push({
                    id: raw.id || String(Date.now() + Math.random()),
                    shopName: shopName === 'Results' ? (raw.category || 'Local Business') : shopName,
                    category: raw.category || 'Local Business',
                    ownerName: raw.ownerName || 'Not Listed',
                    rating: raw.rating || 'N/A',
                    reviews: raw.reviews || '0',
                    phone: raw.phone || 'N/A',
                    email: raw.email || 'None',
                    socials: raw.socials || '{}',
                    address: raw.address || 'N/A',
                    openingHours: raw.openingHours || 'Not Specified',
                    website: raw.website || 'None',
                    mapsUrl: raw.mapsUrl || '',
                    siteStatus: raw.siteStatus || 'Missing',
                    opportunity: raw.opportunity || 'Pitch Web Development',
                    techStack: raw.techStack || 'None',
                    searchQuery: raw.searchQuery || 'Default Search',
                    status: raw.status || 'New',
                    notes: raw.notes || '',
                    createdAt: raw.createdAt || new Date().toISOString()
                });
            })
            .on('end', () => resolve(leads))
            .on('error', (err) => {
                console.error('CSV Read Error:', err);
                resolve([]);
            });
    });
}

// Helper: Save Leads to CSV safely
function saveLeads(leads) {
    try {
        if (!leads || leads.length === 0) {
            const header = CSV_FIELDS.map(f => `"${f}"`).join(',') + '\n';
            fs.writeFileSync(CSV_FILE, header, 'utf8');
            return;
        }
        // Always ensure leads are canonically deduplicated before writing to disk
        const uniqueLeads = deduplicateLeads(leads);
        const json2csv = new Parser({ fields: CSV_FIELDS });
        const csv = json2csv.parse(uniqueLeads);
        fs.writeFileSync(CSV_FILE, csv, 'utf8');
    } catch (err) {
        console.error('Error saving CSV:', err);
    }
}

// API: Get All Leads
app.get('/api/leads', async (req, res) => {
    const leads = await readLeads();
    res.json(leads);
});

// API: Manually Trigger Deduplication Cleanup
app.post('/api/leads/deduplicate', async (req, res) => {
    try {
        const rawLeads = await readLeads();
        const initialCount = rawLeads.length;
        const dedupedLeads = deduplicateLeads(rawLeads);
        saveLeads(dedupedLeads);
        const removed = initialCount - dedupedLeads.length;
        res.json({
            success: true,
            totalBefore: initialCount,
            totalAfter: dedupedLeads.length,
            removedCount: removed,
            leads: dedupedLeads
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Update Lead Status & Notes
app.post('/api/leads/update', async (req, res) => {
    const { id, status, notes } = req.body;
    let leads = await readLeads();
    leads = leads.map(l => {
        if (String(l.id) === String(id)) {
            return {
                ...l,
                status: status !== undefined ? status : l.status,
                notes: notes !== undefined ? notes : l.notes
            };
        }
        return l;
    });
    saveLeads(leads);
    res.json({ success: true });
});

// API: Delete Single Lead
app.post('/api/leads/delete', async (req, res) => {
    const { id } = req.body;
    let leads = await readLeads();
    leads = leads.filter(l => String(l.id) !== String(id));
    saveLeads(leads);
    res.json({ success: true });
});

// API: Clear Leads (All or by specific Search Query)
app.post('/api/leads/clear', async (req, res) => {
    const { query } = req.body;
    let leads = await readLeads();
    if (query && query !== 'ALL') {
        leads = leads.filter(l => l.searchQuery !== query);
    } else {
        leads = [];
    }
    saveLeads(leads);
    res.json({ success: true });
});

// API: Export Leads to Full CSV Download
app.get('/api/leads/export', async (req, res) => {
    const { query, status } = req.query;
    let leads = await readLeads();

    if (query && query !== 'ALL') {
        leads = leads.filter(l => l.searchQuery === query);
    }
    if (status && status !== 'ALL') {
        leads = leads.filter(l => l.status === status);
    }

    const json2csv = new Parser({ fields: CSV_FIELDS });
    const csv = leads.length > 0 ? json2csv.parse(leads) : CSV_FIELDS.map(f => `"${f}"`).join(',') + '\n';

    const filename = `leads_${query ? query.replace(/[^a-zA-Z0-9_-]/g, '_') : 'all'}_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
});

// API: Export Targeted Cold Outreach CSV (Owner Name, Company Name, Phone Number, Email)
app.get('/api/leads/export-outreach', async (req, res) => {
    const { query, status, onlyWithEmail } = req.query;
    let leads = await readLeads();

    if (query && query !== 'ALL') {
        leads = leads.filter(l => l.searchQuery === query);
    }
    if (status && status !== 'ALL') {
        leads = leads.filter(l => l.status === status);
    }
    if (onlyWithEmail === 'true') {
        leads = leads.filter(l => l.email && l.email !== 'None' && l.email.includes('@'));
    }

    const outreachFields = ['Owner Name', 'Company Name', 'Phone Number', 'Email'];
    const outreachData = leads.map(l => ({
        'Owner Name': l.ownerName && l.ownerName !== 'Not Listed' ? l.ownerName : 'Business Owner',
        'Company Name': l.shopName || 'Local Business',
        'Phone Number': l.phone && l.phone !== 'N/A' ? l.phone : '',
        'Email': l.email && l.email !== 'None' ? l.email : ''
    }));

    const json2csv = new Parser({ fields: outreachFields });
    const csv = outreachData.length > 0 ? json2csv.parse(outreachData) : outreachFields.map(f => `"${f}"`).join(',') + '\n';

    const filename = `outreach_${query ? query.replace(/[^a-zA-Z0-9_-]/g, '_') : 'all'}_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
});

// Socket Connection for Real-Time Scrape Updates & Live Streaming
io.on('connection', (socket) => {
    socket.on('start-scrape', async (options) => {
        try {
            const { businessType, location, useCurrentLocation } = options;
            const queryName = useCurrentLocation ? `${businessType} (Near Me)` : (location ? `${businessType} in ${location}` : businessType);

            socket.emit('scrape-started', { query: queryName });

            const newLeads = await scrapeGoogleMaps(
                options,
                (progressMsg) => {
                    socket.emit('progress', progressMsg);
                },
                (singleLead) => {
                    socket.emit('lead-stream', singleLead);
                }
            );

            const existingLeads = await readLeads();

            // Find strictly new leads that don't match any existing lead
            const uniqueNewLeads = newLeads.filter(nl => !existingLeads.some(el => isSameLead(el, nl)));

            // Combine and canonicalize full dataset
            const combined = deduplicateLeads([...newLeads, ...existingLeads]);
            saveLeads(combined);

            socket.emit('scrape-complete', {
                allLeads: combined,
                newLeads: uniqueNewLeads,
                query: queryName
            });
        } catch (err) {
            console.error('Scrape execution error:', err);
            socket.emit('progress', `Error: ${err.message}`);
        }
    });
});

const PORT = process.env.PORT || 3000;
if (require.main === module || !process.env.VERCEL) {
    server.listen(PORT, async () => {
        console.log(`🚀 Lead Finder Dashboard live at: http://localhost:${PORT}`);
        // Auto-clean any existing historical duplicates on startup
        try {
            const raw = await readLeads();
            if (raw.length > 0) {
                const deduped = deduplicateLeads(raw);
                if (deduped.length !== raw.length) {
                    console.log(`🧹 Cleaned ${raw.length - deduped.length} duplicate leads from storage on startup.`);
                    saveLeads(deduped);
                }
            }
        } catch (e) {
            console.error('Startup deduplication error:', e.message);
        }
    });
}

module.exports = app;