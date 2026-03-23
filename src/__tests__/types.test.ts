import { describe, it, expect } from 'vitest';
import type { FpdfDocument, PdfField, Placement } from '../types.js';

describe('FpdfDocument shape', () => {
  it('accepts a valid minimal document', () => {
    const placement: Placement = { x: 10, y: 20, width: 100, height: 18 };

    const field: PdfField = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'FirstName',
      type: 'text',
      label: 'First Name',
      displayName: 'First Name',
      placement,
      value: '',
      required: false,
      readOnly: false,
      options: [],
    };

    const doc: FpdfDocument = {
      metadata: {
        version: '1.0',
        originalPdf: '/tmp/form.pdf',
        pdfFilename: 'form.pdf',
        pdfHash: 'sha256:abc123',
        createdAt: '2026-03-22T10:00:00Z',
        updatedAt: '2026-03-22T10:00:00Z',
        pageCount: 1,
      },
      pages: [
        {
          pageNumber: 1,
          widthPt: 612,
          heightPt: 792,
          pageType: 'acroform' as const,
          fields: [field],
          candidateFields: [],
          textBlocks: [],
        },
      ],
    };

    expect(doc.metadata.version).toBe('1.0');
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0]?.fields).toHaveLength(1);
    expect(doc.pages[0]?.fields[0]?.type).toBe('text');
  });

  it('accepts a checkbox field with a boolean value', () => {
    const field: PdfField = {
      id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
      name: 'Agree',
      type: 'checkbox',
      label: 'I agree',
      displayName: 'I agree',
      placement: { x: 10, y: 10, width: 12, height: 12 },
      value: true,
      required: true,
      readOnly: false,
      options: [],
    };

    expect(typeof field.value).toBe('boolean');
    expect(field.value).toBe(true);
  });

  it('accepts a select field with options', () => {
    const field: PdfField = {
      id: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
      name: 'Color',
      type: 'select',
      label: 'Favorite color',
      displayName: 'Favorite color',
      placement: { x: 10, y: 10, width: 100, height: 20 },
      value: 'blue',
      required: false,
      readOnly: false,
      options: ['red', 'green', 'blue'],
    };

    expect(field.options).toContain('blue');
    expect(field.value).toBe('blue');
  });
});
