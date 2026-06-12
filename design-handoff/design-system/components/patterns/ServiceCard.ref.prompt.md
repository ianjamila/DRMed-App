Homepage service-grid tile: icon + name + description + cyan price.

```jsx
<ServiceCard icon="🧪" name="Laboratory Tests"
  description="CBC, urinalysis, blood chemistry, lipid and thyroid panels."
  price="Varies by test" />
```

Built on `Card` (hover lift). `icon` accepts an emoji glyph (matches the live drmed.ph site) or any SVG node. Pass `href` to make the whole tile a link. Lay tiles in a 4-up grid.
