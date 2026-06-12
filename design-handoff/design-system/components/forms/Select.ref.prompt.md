Skinned native `<select>` with a custom chevron — keeps platform a11y.

```jsx
<Select placeholder="Choose a service" options={["Consultation","Lab Test","X-Ray","ECG"]} />
<Select options={[{value:"qc",label:"Quezon City"}]} />
```

Pass `options` as strings or `{value,label}`; `placeholder` for an empty first row; `invalid` for the error state.
