#!/usr/bin/env node

import { createCanvas, loadImage } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function smartCropIcon() {
    const inputPath = path.join(__dirname, '..', 'assets', 'reddit-mcp-buddy-icon.png');
    const outputPath = path.join(__dirname, '..', 'assets', 'reddit-icon.png');

    const img = await loadImage(inputPath);

    // Create a temporary canvas to analyze the image
    const tempCanvas = createCanvas(img.width, img.height);
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(img, 0, 0);

    const imageData = tempCtx.getImageData(0, 0, img.width, img.height);
    const pixels = imageData.data;

    // Find the bounds of non-white content
    let minX = img.width;
    let minY = img.height;
    let maxX = 0;
    let maxY = 0;

    // Scan for non-white pixels (white = 255,255,255)
    for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
            const idx = (y * img.width + x) * 4;
            const r = pixels[idx];
            const g = pixels[idx + 1];
            const b = pixels[idx + 2];
            const a = pixels[idx + 3];

            // Check if pixel is not white or transparent
            // Allow some tolerance for anti-aliasing
            if (a > 10 && !(r > 250 && g > 250 && b > 250)) {
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }
    }

    // Add a small padding to ensure we don't cut off anti-aliased edges
    const padding = 2;
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(img.width - 1, maxX + padding);
    maxY = Math.min(img.height - 1, maxY + padding);

    const cropWidth = maxX - minX + 1;
    const cropHeight = maxY - minY + 1;

    // Make it square (use the larger dimension)
    const size = Math.max(cropWidth, cropHeight);

    // Create the final 256x256 canvas
    const finalSize = 256;
    const canvas = createCanvas(finalSize, finalSize);
    const ctx = canvas.getContext('2d');

    // Center the cropped content if it's not perfectly square
    const offsetX = (size - cropWidth) / 2;
    const offsetY = (size - cropHeight) / 2;

    // Draw with proper scaling
    ctx.drawImage(
        img,
        minX, minY,                    // Source position
        cropWidth, cropHeight,         // Source dimensions
        offsetX * (finalSize/size),    // Dest X (centered if needed)
        offsetY * (finalSize/size),    // Dest Y (centered if needed)
        cropWidth * (finalSize/size),  // Dest width
        cropHeight * (finalSize/size)  // Dest height
    );

    // Save the result
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outputPath, buffer);

    console.log('✅ Smart crop completed successfully');
    console.log(`📐 Cropped from ${img.width}x${img.height} to ${finalSize}x${finalSize}`);
    console.log(`🎯 Content bounds: [${minX},${minY}] to [${maxX},${maxY}]`);
    console.log('🔄 Rounded corners preserved');
}

smartCropIcon().catch(console.error);