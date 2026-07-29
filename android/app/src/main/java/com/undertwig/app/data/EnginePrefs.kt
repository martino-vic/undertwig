package com.undertwig.app.data

import android.content.Context

enum class LatexEngineId(val id: String, val label: String) {
    PdfLaTeX("pdflatex", "pdfLaTeX"),
    LuaLaTeX("lualatex", "LuaLaTeX"),
    ;

    companion object {
        fun fromId(raw: String?): LatexEngineId {
            return entries.firstOrNull { it.id == raw } ?: PdfLaTeX
        }
    }
}

enum class BibToolId(val id: String, val label: String) {
    BibTeX("bibtex", "BibTeX"),
    Biber("biber", "Biber"),
    ;

    companion object {
        fun fromId(raw: String?): BibToolId {
            return entries.firstOrNull { it.id == raw } ?: BibTeX
        }
    }
}

class EnginePrefs(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun latexEngine(): LatexEngineId =
        LatexEngineId.fromId(prefs.getString(KEY_LATEX, LatexEngineId.PdfLaTeX.id))

    fun setLatexEngine(engine: LatexEngineId) {
        prefs.edit().putString(KEY_LATEX, engine.id).apply()
    }

    fun bibTool(): BibToolId =
        BibToolId.fromId(prefs.getString(KEY_BIB, BibToolId.BibTeX.id))

    fun setBibTool(tool: BibToolId) {
        prefs.edit().putString(KEY_BIB, tool.id).apply()
    }

    companion object {
        private const val PREFS = "undertwig_engine"
        private const val KEY_LATEX = "latex_engine"
        private const val KEY_BIB = "bib_tool"
    }
}
