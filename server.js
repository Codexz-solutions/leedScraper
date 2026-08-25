const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const csvParser = require('csv-parser');
const { Parser } = require('json2csv');
const { scrapeGoogleMaps } = require('./scraper');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const CSV_FILE = path.join(__dirname, 'leads.csv');

app.use(express.json());
app.use(express.static(__dirname));

// Helper: Read CSV
function readLeads() {
    return new Promise((resolve) => {
        if (!fs.existsSync(CSV_FILE)) return resolve([]);
        const leads = [];
        fs.createReadStream(CSV_FILE)
            .pipe(csvParser())
            .on('data', (data) => leads.push(data))
            .on('end', () => resolve(leads));
    });
}

// Helper: Save Leads to CSV
function saveLeads(leads) {
    const json2csv = new Parser();
    const csv = json2csv.parse(leads);
    fs.writeFileSync(CSV_FILE, csv);
}

// API Routes
app.get('/api/leads', async (req, res) => {
    const leads = await readLeads();
    res.json(leads);
});

app.post('/api/leads/update', async (req, res) => {
    const { id, status, notes } = req.body;
    let leads = await readLeads();
    leads = leads.map(l => l.id == id ? { ...l, status, notes } : l);
    saveLeads(leads);
    res.json({ success: true });
});

// Socket Connection for Real-Time Scrape Updates
io.on('connection', (socket) => {
    socket.on('start-scrape', async (query) => {
        try {
            const newLeads = await scrapeGoogleMaps(query, (msg) => {
                socket.emit('progress', msg);
            });

            const existingLeads = await readLeads();
            const combined = [...existingLeads, ...newLeads];
            saveLeads(combined);

            socket.emit('scrape-complete', combined);
        } catch (err) {
            socket.emit('progress', `Error: ${err.message}`);
        }
    });
});

server.listen(3000, () => {
    console.log(' Dashboard live at: http://localhost:3000');
});