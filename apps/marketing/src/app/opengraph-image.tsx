import { ImageResponse } from 'next/og';

export const alt = 'BYOK Grid — Own the data. Bring the keys.';
export const size = { height: 630, width: 1200 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        alignItems: 'stretch',
        background: '#0a0c0b',
        color: '#f3f7f4',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Arial, sans-serif',
        height: '100%',
        justifyContent: 'space-between',
        padding: '72px 80px',
        position: 'relative',
        width: '100%',
      }}
    >
      <div
        style={{
          background:
            'radial-gradient(circle at 80% 10%, rgba(184,243,74,.2), transparent 42%)',
          display: 'flex',
          inset: 0,
          position: 'absolute',
        }}
      />
      <div style={{ alignItems: 'center', display: 'flex', gap: 20 }}>
        <div
          style={{
            alignItems: 'center',
            background: '#b8f34a',
            borderRadius: 14,
            color: '#10140d',
            display: 'flex',
            fontSize: 30,
            fontWeight: 900,
            height: 64,
            justifyContent: 'center',
            width: 64,
          }}
        >
          B
        </div>
        <div style={{ display: 'flex', fontSize: 30, fontWeight: 800 }}>
          BYOK Grid
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
        <div
          style={{
            color: '#b8f34a',
            display: 'flex',
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: 4,
            textTransform: 'uppercase',
          }}
        >
          Open source · SQLite first
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 76,
            fontWeight: 850,
            letterSpacing: -4,
            lineHeight: 1,
            maxWidth: 980,
          }}
        >
          Own the data. Bring the keys. Build the workflow.
        </div>
      </div>
    </div>,
    size
  );
}
