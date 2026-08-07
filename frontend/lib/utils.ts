import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge has to be told about the §1 type scale, and this is not
// optional politeness — leaving it out is a silent contrast bug.
//
// The default config classifies any unrecognised `text-*` as a *colour*, because
// its font-size matcher only knows t-shirt sizes (text-sm, text-lg, …). So
// `cn("text-ink", "text-body-sm")` looked like two colours to it, the later one
// won, and `text-ink` was dropped from the output entirely. The result was
// #E8EAED body text on the #FAFAFA cards — 1.1:1, invisible — from a merge
// helper doing exactly what it was configured to do.
//
// Registering the scale under `font-size` puts the two in different groups, so
// both survive. Any new size token added to globals.css belongs in this list.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "headline-lg",
            "headline-md",
            "body-lg",
            "body-md",
            "body-sm",
            "label-sm",
          ],
        },
      ],
    },
  },
});

/** Standard shadcn class merge. Later utilities win over earlier ones, so a
 *  variant can be overridden at the call site without specificity games. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
