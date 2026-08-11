# Extension Assets

This folder should contain the extension icons:

- `icon-16.png` - 16x16 pixel icon
- `icon-32.png` - 32x32 pixel icon
- `icon-48.png` - 48x48 pixel icon
- `icon-128.png` - 128x128 pixel icon

## Design Guidelines

- Use the EffortlessInsight brand colors
- Include a shield or checkmark to represent "guard" functionality
- Keep it simple and recognizable at small sizes
- Use PNG format with transparency

## Placeholder Generation

You can generate placeholder icons using this SVG and converting to PNG:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#007bff;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#0056b3;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="24" fill="url(#grad)"/>
  <path d="M64 20 L100 40 V65 C100 85 85 100 64 110 C43 100 28 85 28 65 V40 Z"
        fill="none" stroke="white" stroke-width="6"/>
  <path d="M50 64 L60 74 L78 52"
        fill="none" stroke="white" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

Convert using ImageMagick or an online tool like CloudConvert.
