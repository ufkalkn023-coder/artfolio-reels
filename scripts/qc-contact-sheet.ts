export type ContactSheetLayout = {
  columns: number;
  rows: number;
  positions: readonly string[];
};

const repeatedDimension = (dimension: "w0" | "h0", count: number): string =>
  count === 0 ? "0" : Array.from({ length: count }, () => dimension).join("+");

export const createContactSheetLayout = (
  inputCount: number,
  maxColumns = 4,
): ContactSheetLayout => {
  if (!Number.isInteger(inputCount) || inputCount < 1) {
    throw new Error(`Contact sheet input count must be a positive integer, received ${inputCount}.`);
  }
  if (!Number.isInteger(maxColumns) || maxColumns < 1) {
    throw new Error(`Contact sheet column count must be a positive integer, received ${maxColumns}.`);
  }

  const columns = Math.min(inputCount, maxColumns);
  const rows = Math.ceil(inputCount / columns);
  const positions = Array.from({ length: inputCount }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return `${repeatedDimension("w0", column)}_${repeatedDimension("h0", row)}`;
  });

  return { columns, rows, positions };
};

export const buildContactSheetFfmpegArgs = (
  inputs: readonly string[],
  output: string,
): string[] => {
  const layout = createContactSheetLayout(inputs.length);
  const inputLabels = inputs.map((_, index) => `[${index}:v]`).join("");
  const outputLabel = "[contact-sheet]";
  const filter = inputs.length === 1
    ? `${inputLabels}null${outputLabel}`
    : `${inputLabels}xstack=inputs=${inputs.length}:layout=${layout.positions.join("|")}:fill=black${outputLabel}`;

  return [
    "-y",
    ...inputs.flatMap((input) => ["-i", input]),
    "-filter_complex",
    filter,
    "-map",
    outputLabel,
    "-frames:v",
    "1",
    "-update",
    "1",
    output,
  ];
};
