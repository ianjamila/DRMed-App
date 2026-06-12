Universal white content container — hairline ring, 14px radius, optional hover lift.

```jsx
<Card interactive>
  <CardTitle>Laboratory Tests</CardTitle>
  <CardDescription>CBC, urinalysis, blood chemistry, lipid and thyroid panels.</CardDescription>
  <CardFooter><span style={{fontWeight:700,color:"var(--color-brand-cyan)"}}>Varies by test</span></CardFooter>
</Card>
```

Set `interactive` for clickable cards (adds shadow lift). Slots `CardTitle`, `CardDescription`, `CardFooter` are optional — compose freely. Default padding 24px.
