// Shared classification helpers: maps a MIME part's content type (and,
// where relevant, its Content-Disposition) to a color "family" + "shade",
// and to a short abbreviated label for display inside a fixed-size chip.
//
// Loaded as a plain script in both the background context and the message
// display (pane) context, so it must not use ES module import/export.

var MimeColors = (function () {
  function baseContentType(ct) {
    return (ct || '').toLowerCase().split(';')[0].trim();
  }

  function getDisposition(headers) {
    const h =
      headers &&
      (headers['content-disposition'] || headers['Content-Disposition']);
    if (!h || !h.length) return null;
    const v = String(h[0]).toLowerCase();
    if (v.startsWith('attachment')) return 'attachment';
    if (v.startsWith('inline')) return 'inline';
    return null;
  }

  // Returns { family, shade } where shade is 'inline' | 'attachment' | null.
  // null shade means the family isn't shaded (containers, crypto wrappers,
  // embedded messages).
  function classify(rawContentType, headers) {
    const ct = baseContentType(rawContentType);

    if (ct === 'message/rfc822' || ct === 'message/global') {
      return { family: 'embedded', shade: null };
    }

    if (
      ct === 'multipart/signed' ||
      ct === 'multipart/encrypted' ||
      ct.startsWith('application/pgp') ||
      ct.startsWith('application/pkcs7') ||
      ct.startsWith('application/x-pkcs7')
    ) {
      return { family: 'crypto', shade: null };
    }

    if (ct.startsWith('multipart/')) {
      return { family: 'multipart', shade: null };
    }

    const disposition = getDisposition(headers);
    const shade = disposition === 'attachment' ? 'attachment' : 'inline';

    if (ct === 'text/html') return { family: 'html', shade };
    if (ct === 'text/plain') return { family: 'plain', shade };
    if (ct.startsWith('text/')) return { family: 'othertext', shade };
    if (ct.startsWith('image/')) return { family: 'image', shade };
    if (ct.startsWith('audio/') || ct.startsWith('video/')) {
      return { family: 'media', shade };
    }
    return { family: 'generic', shade };
  }

  const SHORT_LABELS = {
    'multipart/mixed': 'mixed',
    'multipart/alternative': 'alt',
    'multipart/related': 'related',
    'multipart/digest': 'digest',
    'multipart/parallel': 'parallel',
    'multipart/report': 'report',
    'multipart/signed': 'signed',
    'multipart/encrypted': 'encrypted',
    'text/html': 'html',
    'text/plain': 'plain',
    'text/enriched': 'enriched',
    'text/rtf': 'rtf',
    'text/markdown': 'md',
    'message/rfc822': 'msg',
    'message/global': 'msg',
  };

  function shortLabel(rawContentType) {
    const ct = baseContentType(rawContentType);
    if (SHORT_LABELS[ct]) return SHORT_LABELS[ct];
    const subtype = ct.split('/')[1] || ct || '?';
    return subtype.length > 12 ? subtype.slice(0, 11) + '\u2026' : subtype;
  }

  return { classify, shortLabel, getDisposition };
})();
