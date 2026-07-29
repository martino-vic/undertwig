package com.undertwig.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation

/** Paths that get LaTeX-style syntax highlighting in the editor. */
fun isHighlightableTexPath(path: String): Boolean {
    val ext = path.substringAfterLast('.', "").lowercase()
    return ext in HIGHLIGHT_EXTENSIONS
}

private val HIGHLIGHT_EXTENSIONS = setOf(
    "tex", "sty", "cls", "clo", "dtx", "ltx", "tikz", "bib",
)

private val STRUCTURAL_COMMANDS = setOf(
    "documentclass", "usepackage", "RequirePackage", "begin", "end",
    "input", "include", "includeonly",
    "newcommand", "renewcommand", "providecommand",
    "newenvironment", "renewenvironment",
    "section", "subsection", "subsubsection", "paragraph", "subparagraph",
    "chapter", "part",
    "label", "ref", "eqref", "pageref", "cite", "nocite",
    "bibliography", "bibliographystyle", "addbibresource",
    "item", "caption", "title", "author", "date", "maketitle", "tableofcontents",
    "includegraphics", "href", "url", "footnote", "emph",
    "textbf", "textit", "texttt",
    "centering", "hspace", "vspace", "newline", "newpage", "clearpage",
)

private data class TexPalette(
    val default: Color,
    val comment: Color,
    val command: Color,
    val control: Color,
    val environment: Color,
    val math: Color,
    val bracket: Color,
    val number: Color,
    val operator: Color,
)

/** Colors aligned with the website Monaco “undertwig” theme. */
private fun palette(dark: Boolean): TexPalette {
    return if (dark) {
        TexPalette(
            default = Color(0xFFF3F7FB),
            comment = Color(0xFF7F8B99),
            command = Color(0xFFD08A45),
            control = Color(0xFFE0A05A),
            environment = Color(0xFF7EB6E0),
            math = Color(0xFF8FBF8F),
            bracket = Color(0xFFC7D1DC),
            number = Color(0xFFC9A0DC),
            operator = Color(0xFFD08A45),
        )
    } else {
        TexPalette(
            default = Color(0xFF1B242E),
            comment = Color(0xFF6B7785),
            command = Color(0xFFB87333),
            control = Color(0xFF9A5A20),
            environment = Color(0xFF2A6F9E),
            math = Color(0xFF3D7A3D),
            bracket = Color(0xFF5A6570),
            number = Color(0xFF7A4A9A),
            operator = Color(0xFFB87333),
        )
    }
}

fun highlightTex(source: String, dark: Boolean): AnnotatedString {
    val colors = palette(dark)
    val builder = AnnotatedString.Builder(source.length)
    var i = 0
    while (i < source.length) {
        when {
            source[i] == '%' -> {
                val end = source.indexOf('\n', i).let { if (it < 0) source.length else it }
                appendStyled(builder, source, i, end, SpanStyle(color = colors.comment, fontStyle = FontStyle.Italic))
                i = end
            }
            source.startsWith("$$", i) -> {
                val close = source.indexOf("$$", i + 2).let { if (it < 0) source.length else it + 2 }
                appendMath(builder, source, i, close, colors)
                i = close
            }
            source[i] == '$' -> {
                val close = source.indexOf('$', i + 1).let { if (it < 0) source.length else it + 1 }
                appendMath(builder, source, i, close, colors)
                i = close
            }
            source.startsWith("\\[", i) -> {
                val close = source.indexOf("\\]", i + 2).let { if (it < 0) source.length else it + 2 }
                appendMath(builder, source, i, close, colors)
                i = close
            }
            source.startsWith("\\(", i) -> {
                val close = source.indexOf("\\)", i + 2).let { if (it < 0) source.length else it + 2 }
                appendMath(builder, source, i, close, colors)
                i = close
            }
            source[i] == '\\' -> {
                i = appendCommand(builder, source, i, colors)
            }
            source[i] == '{' || source[i] == '}' -> {
                appendStyled(builder, source, i, i + 1, SpanStyle(color = colors.bracket))
                i += 1
            }
            source[i] == '[' || source[i] == ']' -> {
                appendStyled(builder, source, i, i + 1, SpanStyle(color = colors.bracket))
                i += 1
            }
            source[i] == '&' || source[i] == '~' || source[i] == '^' || source[i] == '_' -> {
                appendStyled(builder, source, i, i + 1, SpanStyle(color = colors.operator))
                i += 1
            }
            source[i].isDigit() -> {
                var end = i + 1
                while (end < source.length && (source[end].isDigit() || source[end] == '.')) {
                    end++
                }
                val unitEnd = matchUnit(source, end)
                appendStyled(builder, source, i, unitEnd, SpanStyle(color = colors.number))
                i = unitEnd
            }
            else -> {
                builder.append(source[i])
                // Default foreground comes from TextStyle on the field.
                i += 1
            }
        }
    }
    return builder.toAnnotatedString()
}

private fun matchUnit(source: String, start: Int): Int {
    val units = arrayOf("em", "ex", "pt", "pc", "bp", "sp", "cm", "mm", "in", "mu")
    for (unit in units) {
        if (source.startsWith(unit, start)) return start + unit.length
    }
    return start
}

private fun appendCommand(
    builder: AnnotatedString.Builder,
    source: String,
    start: Int,
    colors: TexPalette,
): Int {
    if (start + 1 >= source.length) {
        appendStyled(builder, source, start, start + 1, SpanStyle(color = colors.command))
        return start + 1
    }
    val next = source[start + 1]
    if (!next.isLetter() && next != '@') {
        appendStyled(builder, source, start, start + 2, SpanStyle(color = colors.command))
        return start + 2
    }
    var end = start + 1
    while (end < source.length && (source[end].isLetter() || source[end] == '@')) {
        end++
    }
    val name = source.substring(start + 1, end)
    val isBeginEnd = name == "begin" || name == "end"
    val control = name in STRUCTURAL_COMMANDS
    val style = when {
        control -> SpanStyle(color = colors.control, fontWeight = FontWeight.Bold)
        else -> SpanStyle(color = colors.command)
    }
    appendStyled(builder, source, start, end, style)

    if (isBeginEnd) {
        var cursor = end
        while (cursor < source.length && source[cursor].isWhitespace() && source[cursor] != '\n') {
            builder.append(source[cursor])
            cursor++
        }
        if (cursor < source.length && source[cursor] == '{') {
            appendStyled(builder, source, cursor, cursor + 1, SpanStyle(color = colors.bracket))
            cursor++
            val envStart = cursor
            while (cursor < source.length && source[cursor] != '}' && source[cursor] != '\n') {
                cursor++
            }
            if (cursor > envStart) {
                appendStyled(
                    builder,
                    source,
                    envStart,
                    cursor,
                    SpanStyle(color = colors.environment),
                )
            }
            if (cursor < source.length && source[cursor] == '}') {
                appendStyled(builder, source, cursor, cursor + 1, SpanStyle(color = colors.bracket))
                cursor++
            }
        }
        return cursor
    }
    return end
}

private fun appendMath(
    builder: AnnotatedString.Builder,
    source: String,
    start: Int,
    end: Int,
    colors: TexPalette,
) {
    var i = start
    while (i < end) {
        if (source[i] == '\\' && i + 1 < end) {
            val cmdEnd = if (!source[i + 1].isLetter() && source[i + 1] != '@') {
                i + 2
            } else {
                var e = i + 1
                while (e < end && (source[e].isLetter() || source[e] == '@')) e++
                e
            }
            appendStyled(builder, source, i, cmdEnd, SpanStyle(color = colors.command))
            i = cmdEnd
        } else if (source[i] == '{' || source[i] == '}') {
            appendStyled(builder, source, i, i + 1, SpanStyle(color = colors.bracket))
            i++
        } else {
            appendStyled(builder, source, i, i + 1, SpanStyle(color = colors.math))
            i++
        }
    }
}

private fun appendStyled(
    builder: AnnotatedString.Builder,
    source: String,
    start: Int,
    end: Int,
    style: SpanStyle,
) {
    val from = builder.pushStyle(style)
    builder.append(source, start, end)
    builder.pop(from)
}

class TexVisualTransformation(
    private val dark: Boolean,
) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        return TransformedText(
            highlightTex(text.text, dark),
            OffsetMapping.Identity,
        )
    }
}
