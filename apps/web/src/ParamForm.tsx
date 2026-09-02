import type { Param, ParamValue, ScadSchema } from "./types";

interface Props {
  schema: ScadSchema;
  values: Record<string, ParamValue>;
  errors: Record<string, string>;
  onChange: (name: string, value: ParamValue) => void;
  onReset: () => void;
  dirty: boolean;
}

/**
 * The configurator.
 *
 * Grouped exactly as the author grouped them in the source, because the author's
 * grouping is a design decision, not incidental. Hidden parameters stay hidden:
 * they are assignable through the API but are not part of the intended interface.
 */
export function ParamForm({ schema, values, errors, onChange, onReset, dirty }: Props) {
  const visible = schema.params.filter((p) => !schema.hidden.includes(p.name));
  const groups = schema.groups.filter((g) => visible.some((p) => p.group === g));

  return (
    <form className="params" onSubmit={(e) => e.preventDefault()}>
      <div className="params-head">
        <h2>Configure</h2>
        <button type="button" className="ghost" onClick={onReset} disabled={!dirty}>
          Reset to defaults
        </button>
      </div>

      {groups.map((group) => (
        <fieldset key={group}>
          <legend>{group}</legend>
          {visible
            .filter((p) => p.group === group)
            .map((param) => (
              <Field
                key={param.name}
                param={param}
                value={values[param.name] ?? param.default}
                error={errors[param.name]}
                onChange={onChange}
              />
            ))}
        </fieldset>
      ))}
    </form>
  );
}

function Field({
  param,
  value,
  error,
  onChange,
}: {
  param: Param;
  value: ParamValue;
  error?: string;
  onChange: (name: string, value: ParamValue) => void;
}) {
  const id = `p-${param.name}`;
  const w = param.widget;

  return (
    <div className={`field${error ? " has-error" : ""}`}>
      <label htmlFor={id}>
        <span className="field-name">{param.description ?? param.name}</span>
        <code className="field-key">{param.name}</code>
      </label>

      {w.kind === "slider" && typeof value === "number" && (
        <div className="slider-row">
          <input
            id={id}
            type="range"
            min={w.min}
            max={w.max}
            step={w.step}
            value={value}
            onChange={(e) => onChange(param.name, Number(e.target.value))}
          />
          <input
            className="num"
            type="number"
            min={w.min}
            max={w.max}
            step={w.step}
            value={value}
            aria-label={`${param.name} value`}
            onChange={(e) => onChange(param.name, Number(e.target.value))}
          />
          <span className="unit">mm</span>
        </div>
      )}

      {w.kind === "spinbox" && typeof value === "number" && (
        <input
          id={id}
          className="num wide"
          type="number"
          value={value}
          onChange={(e) => onChange(param.name, Number(e.target.value))}
        />
      )}

      {w.kind === "checkbox" && typeof value === "boolean" && (
        <label className="switch">
          <input
            id={id}
            type="checkbox"
            checked={value}
            onChange={(e) => onChange(param.name, e.target.checked)}
          />
          <span>{value ? "Yes" : "No"}</span>
        </label>
      )}

      {w.kind === "select" && (
        <select
          id={id}
          value={String(value)}
          onChange={(e) => {
            const picked = w.options.find((o) => String(o.value) === e.target.value);
            if (picked) onChange(param.name, picked.value);
          }}
        >
          {w.options.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      )}

      {w.kind === "text" && typeof value === "string" && (
        <input
          id={id}
          type="text"
          maxLength={w.maxLength}
          value={value}
          onChange={(e) => onChange(param.name, e.target.value)}
        />
      )}

      {w.kind === "vector" && Array.isArray(value) && (
        <div className="vector-row">
          {value.map((component, i) => (
            <input
              key={i}
              className="num"
              type="number"
              min={w.min}
              max={w.max}
              step={w.step}
              value={component}
              aria-label={`${param.name} component ${i + 1}`}
              onChange={(e) => {
                const next = [...value];
                next[i] = Number(e.target.value);
                onChange(param.name, next);
              }}
            />
          ))}
        </div>
      )}

      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
