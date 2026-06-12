Brand action button — use for every clickable action; `cta` (cyan) for the single hero action on a view, `brand` (navy→cyan) for everything else.

```jsx
<Button variant="cta" size="lg" href="/schedule">Book Appointment</Button>
<Button variant="outline">Meet Our Doctors</Button>
<Button variant="brand" trailingIcon={<span>→</span>}>View Packages</Button>
```

Variants: `brand` (default, navy→cyan), `cta` (cyan→navy, the primary hero action), `navy` (solid, for dark sections), `outline` (inverts on hover), `secondary`, `ghost`, `success` (emerald), `destructive`, `link`.
Sizes: `sm` `md` (default) `lg` `touch` (44px hit target for mobile) `icon`. Pass `href` to render an anchor, `fullWidth` to stretch, `leadingIcon`/`trailingIcon` for glyphs.
