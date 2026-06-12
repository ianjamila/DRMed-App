Label + control + hint/error wrapper. Put the Input/Textarea/Select inside.

```jsx
<Field label="DRM-ID" htmlFor="drm" hint="On your official receipt" required>
  <Input id="drm" placeholder="DRM-0001" />
</Field>
<Field label="Email" htmlFor="em" error="Enter a valid email">
  <Input id="em" invalid />
</Field>
```

`error` overrides `hint` and renders red. `required` adds a red asterisk.
