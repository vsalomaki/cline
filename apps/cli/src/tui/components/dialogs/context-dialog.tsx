// @jsxImportSource @opentui/react
import type { LastContextUsage } from "@cline/core";
import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialogKeyboard } from "@opentui-ui/dialog/react";
import { useDialogPalette, useTheme } from "../../hooks/use-theme";
import { buildContextUsageView } from "./context-dialog-helpers";

const LABEL_WIDTH = 28;
const TOKENS_WIDTH = 10;

export function ContextDialogContent(
	props: ChoiceContext<void> & { usage: LastContextUsage | undefined },
) {
	const { dismiss, dialogId, usage } = props;
	const palette = useDialogPalette();
	const theme = useTheme();

	useDialogKeyboard((key) => {
		if (
			key.name === "escape" ||
			key.name === "return" ||
			key.name === "enter" ||
			key.name === "q"
		) {
			dismiss();
		}
	}, dialogId);

	const view = usage ? buildContextUsageView(usage) : undefined;
	const offset = view?.bar.markerOffset;
	return (
		<box flexDirection="column" paddingX={1}>
			<text fg="white">Context usage</text>
			{view ? (
				<scrollbox flexGrow={1}>
					<box flexDirection="column">
						<text fg="gray">{view.summary}</text>
						{view.note && <text fg={theme.accents.plan}>{view.note}</text>}
						<text>
							<span fg={palette.act}>{view.bar.filled}</span>
							{offset === undefined ? (
								<span fg="gray">{view.bar.empty}</span>
							) : (
								<>
									<span fg="gray">{view.bar.empty.slice(0, offset)}</span>
									<span fg={theme.accents.plan}>
										{view.bar.empty.slice(offset, offset + 1)}
									</span>
									<span fg="gray">{view.bar.empty.slice(offset + 1)}</span>
								</>
							)}
						</text>
						<text> </text>
						{view.rows.map((row) => (
							<box key={row.id} flexDirection="row" paddingX={1}>
								<text
									fg={row.sub ? "gray" : "white"}
									width={LABEL_WIDTH}
									flexShrink={0}
								>
									{row.sub ? `  ${row.label}` : row.label}
								</text>
								<text fg={palette.act} width={TOKENS_WIDTH} flexShrink={0}>
									{row.tokens.toLocaleString()}
								</text>
								<text fg="gray">{row.share}</text>
							</box>
						))}
						<text> </text>
						<text fg="gray">{view.compaction}</text>
					</box>
				</scrollbox>
			) : (
				<text fg="gray">
					No breakdown yet. It appears after the agent's next request.
				</text>
			)}

			<text fg="gray" marginTop={1}>
				<em>Esc/Enter to close</em>
			</text>
		</box>
	);
}
