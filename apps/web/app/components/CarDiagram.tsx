import { carDiagramSvg } from '../../lib/carDiagramSvg';

/**
 * The paper SPK's body diagram. The drawing itself lives in
 * lib/carDiagramSvg.ts as a plain string so the pre-purge backup archive can
 * print the identical art without react-dom/server; this wrapper is how the
 * live forms and the print page mount it. Static art — annotation happens in
 * ink on the DiagramInk layer above it, exactly like a pen on the paper.
 */
export function CarDiagram(props: { width?: number | string }) {
  return <span style={{ display: 'block' }} dangerouslySetInnerHTML={{ __html: carDiagramSvg(props.width ?? '100%') }} />;
}
