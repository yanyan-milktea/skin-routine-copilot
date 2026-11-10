/* eslint-disable @next/next/no-img-element --
   Photos are tiny data URLs kept in localStorage or 200px Open Beauty Facts
   thumbnails; next/image optimization does not apply to data URLs and would
   proxy third-party images through this app. */
"use client";

type Props = { src: string; lazy?: boolean };

/** A product photo that hides itself if it fails to load, revealing the color tile behind it. */
export function ProductPhoto({ src, lazy = false }: Props) {
  return <img src={src} alt="" loading={lazy ? "lazy" : undefined} referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} />;
}
