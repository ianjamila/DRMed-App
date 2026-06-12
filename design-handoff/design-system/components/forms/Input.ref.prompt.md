Touch-friendly (44px) text field with a cyan focus ring.

```jsx
<Input placeholder="Juan dela Cruz" />
<Input mono maxLength={8} placeholder="ABCD1234" />   {/* Secure PIN */}
<Input invalid defaultValue="bad@" />
```

`mono` switches to monospace + wide tracking for receipt codes (DRM-ID, Secure PIN). `invalid` applies the red error treatment. Wrap with `Field` for label + hint + error.
