#!/usr/bin/env node

import { createCanvas, loadImage } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function createCroppedIcon() {
    const size = 256;
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Create rounded rectangle path
    function roundedRect(ctx, x, y, width, height, radius) {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }

    // Fill entire canvas with orange background and rounded corners
    // Using standard iOS app icon corner radius (about 22% of size)
    const cornerRadius = size * 0.22;

    // Create clipping mask for rounded corners
    roundedRect(ctx, 0, 0, size, size, cornerRadius);
    ctx.clip();

    // Fill with Reddit orange
    ctx.fillStyle = '#FF4500';
    ctx.fillRect(0, 0, size, size);

    // Draw white circle in center
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.31, 0, 2 * Math.PI);
    ctx.fill();

    // Draw magnifying glass
    ctx.strokeStyle = '#FF4500';
    ctx.lineWidth = size * 0.031; // Scale line width
    ctx.beginPath();
    ctx.arc(size * 0.43, size * 0.43, size * 0.137, 0, 2 * Math.PI);
    ctx.stroke();

    // Draw handle
    ctx.beginPath();
    ctx.moveTo(size * 0.527, size * 0.527);
    ctx.lineTo(size * 0.625, size * 0.625);
    ctx.stroke();

    return canvas.toBuffer('image/png');
}

// Generate the fixed icon
console.log('🔧 Fixing icon crop and rounded corners...');

const iconBuffer = await createCroppedIcon();
const outputPath = path.join(__dirname, '..', 'assets', 'reddit-icon.png');

fs.writeFileSync(outputPath, iconBuffer);

console.log('✅ Icon fixed: assets/reddit-icon.png');
console.log('📐 Icon now has proper rounded corners and no extra whitespace');