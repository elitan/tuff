import { brandOf, textOn, type Brand } from "../lib/brands";

/** Small rounded badge with the company's monogram (or logo, if one is configured). */
export default function BrandBadge({ brand, product, owner, size = "md" }: {
  brand?: Brand; product?: string; owner?: string; size?: "sm" | "md";
}) {
  const b = brand ?? brandOf(product, owner);
  return (
    <span
      className={`brand-badge ${size}`}
      style={{ background: b.color, color: textOn(b.color) }}
      title={b.name}
      aria-label={b.name}
    >
      {b.logo
        ? <img src={`/logos/${b.key}.svg`} alt="" />
        : b.short}
    </span>
  );
}
