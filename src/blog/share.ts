// The share links under a public blog post (site/themes/vault-squarespace/layouts/partials/blog/share.html builds the
// same links in the site's Hugo template; this is their reference, which the tests check). Plain links to each
// network's own share page: no SDKs, no scripts, no counts. Instagram has no web share address, so it gets no link;
// the page gives it a button instead (the browser's share sheet, or else copying the post's address: sq/js/vault-sq.js).

export type ShareNetwork = 'linkedin' | 'facebook' | 'instagram' | 'pinterest' | 'whatsapp';

export interface ShareLink {
  network: ShareNetwork;
  label: string;
  href: string | null;
}

export interface ShareInput {
  url: string;
  title: string;
  description?: string;
  imageUrl?: string;
}

function isAbsoluteHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The post's share links, in the order the page shows them (LinkedIn, Facebook, Instagram, Pinterest, WhatsApp).
 *  `url` must be the post's absolute http(s) address; anything else gives no links. */
export function buildShareLinks({ url, title, imageUrl }: ShareInput): ShareLink[] {
  if (!isAbsoluteHttpUrl(url)) return [];
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(title);
  let pinterest = `https://www.pinterest.com/pin/create/button/?url=${u}&description=${t}`;
  if (isAbsoluteHttpUrl(imageUrl)) pinterest += `&media=${encodeURIComponent(imageUrl)}`;
  return [
    { network: 'linkedin', label: 'LinkedIn', href: `https://www.linkedin.com/sharing/share-offsite/?url=${u}` },
    { network: 'facebook', label: 'Facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${u}` },
    { network: 'instagram', label: 'Instagram', href: null },
    { network: 'pinterest', label: 'Pinterest', href: pinterest },
    { network: 'whatsapp', label: 'WhatsApp', href: `https://wa.me/?text=${encodeURIComponent(`${title} ${url}`)}` },
  ];
}
