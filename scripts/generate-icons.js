#!/usr/bin/env node

import { createCanvas } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create assets directory if it doesn't exist
const assetsDir = path.join(__dirname, '..', 'assets');
if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
}

// Option 1: Browse/Telescope icon
function createBrowseIcon() {
    const canvas = createCanvas(256, 256);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#FF4500'; // Reddit orange
    ctx.fillRect(0, 0, 256, 256);

    // White circle
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(128, 128, 80, 0, 2 * Math.PI);
    ctx.fill();

    // Magnifying glass
    ctx.strokeStyle = '#FF4500';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(110, 110, 35, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(135, 135);
    ctx.lineTo(160, 160);
    ctx.stroke();

    return canvas.toBuffer('image/png');
}

// Option 2: R with arrows
function createArrowsIcon() {
    const canvas = createCanvas(256, 256);
    const ctx = canvas.getContext('2d');

    // Background gradient
    const gradient = ctx.createLinearGradient(0, 0, 256, 256);
    gradient.addColorStop(0, '#FF5700');
    gradient.addColorStop(1, '#FF4500');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 256);

    // White R
    ctx.fillStyle = 'white';
    ctx.font = 'bold 120px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('R', 100, 130);

    // Up arrow
    ctx.beginPath();
    ctx.moveTo(180, 80);
    ctx.lineTo(170, 95);
    ctx.lineTo(190, 95);
    ctx.closePath();
    ctx.fill();

    // Down arrow
    ctx.beginPath();
    ctx.moveTo(180, 180);
    ctx.lineTo(170, 165);
    ctx.lineTo(190, 165);
    ctx.closePath();
    ctx.fill();

    return canvas.toBuffer('image/png');
}

// Option 3: Simple robot
function createRobotIcon() {
    const canvas = createCanvas(256, 256);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#1a1a1b'; // Dark theme
    ctx.fillRect(0, 0, 256, 256);

    // Robot head
    ctx.fillStyle = '#FF4500';
    ctx.fillRect(80, 60, 96, 80);

    // Eyes
    ctx.fillStyle = 'white';
    ctx.fillRect(95, 80, 20, 20);
    ctx.fillRect(141, 80, 20, 20);

    // Antenna
    ctx.strokeStyle = '#FF4500';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(128, 60);
    ctx.lineTo(128, 40);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(128, 35, 5, 0, 2 * Math.PI);
    ctx.fill();

    // Body
    ctx.fillStyle = '#FF4500';
    ctx.fillRect(90, 150, 76, 60);

    // MCP text
    ctx.fillStyle = 'white';
    ctx.font = '20px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('MCP', 128, 180);

    return canvas.toBuffer('image/png');
}

// Generate all three options
console.log('🎨 Generating safe icon alternatives...');

// Save Option 1
fs.writeFileSync(
    path.join(assetsDir, 'reddit-mcp-browse.png'),
    createBrowseIcon()
);
console.log('✅ Created: assets/reddit-mcp-browse.png (Browse/Search icon)');

// Save Option 2
fs.writeFileSync(
    path.join(assetsDir, 'reddit-mcp-arrows.png'),
    createArrowsIcon()
);
console.log('✅ Created: assets/reddit-mcp-arrows.png (R with arrows icon)');

// Save Option 3
fs.writeFileSync(
    path.join(assetsDir, 'reddit-mcp-robot.png'),
    createRobotIcon()
);
console.log('✅ Created: assets/reddit-mcp-robot.png (MCP Robot icon)');

console.log('\n📝 Next steps:');
console.log('1. Choose your preferred icon from the assets folder');
console.log('2. Replace assets/reddit-icon.png with your chosen icon');
console.log('3. Update manifest.json if needed');