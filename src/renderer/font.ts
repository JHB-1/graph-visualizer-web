export const defaultFontFamily = '"Pretendard Variable", Pretendard, system-ui, sans-serif';

export async function readyDefaultFont(): Promise<void>
{
	await document.fonts.load('400 14px "Pretendard Variable"', '그래프 Graph 0123');
}

let embeddedFont: Promise<string> | undefined;

// 독립 SVG 이미지에서는 페이지 글꼴을 재사용하지 않으므로 PNG 출력에 글꼴 포함
export function defaultFontData(): Promise<string>
{
	if (!embeddedFont)
		embeddedFont = fetch(new URL('./fonts/PretendardVariable.woff2', document.baseURI)).then
		(
			async (response): Promise<string> =>
			{
				if (!response.ok) throw new Error('출력용 글꼴을 읽지 못했습니다.');

				const blob = await response.blob();

				return new Promise<string>
				(
					(resolve, reject): void =>
					{
						const reader = new FileReader();
						reader.onload = (): void => {resolve(String(reader.result));};
						reader.onerror = (): void => {reject(new Error('출력용 글꼴을 변환하지 못했습니다.'));};
						reader.readAsDataURL(blob);
					}
				);
			}
		).catch
		(
			(error: unknown): never =>
			{
				embeddedFont = undefined;

				throw error;
			}
		);

	return embeddedFont;
}
