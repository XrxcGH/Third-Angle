<?xml version="1.0" encoding="utf-8"?>
<!--
  What a person sees when they click "Feed".

  /feed.xml is a valid Atom document and always was, but a browser handed
  application/atom+xml either dumps the raw markup on the screen or offers to
  download it. Both read as a broken link. Every feed reader ignores an
  xml-stylesheet instruction, so attaching this costs the machine-readable feed
  nothing and gives the other ninety-nine visitors a page.

  It borrows the site's own stylesheets rather than carrying its own, so the
  feed page inherits the type, the colours and the theme. Nothing is inline:
  the response carries the site CSP, and style-src is 'self'.
-->
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <xsl:output method="html" encoding="utf-8" indent="yes"/>

  <xsl:template match="/">
    <html lang="en">
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title><xsl:value-of select="atom:feed/atom:title"/> · Feed</title>
        <meta name="robots" content="noindex"/>
        <link rel="icon" href="/static/favicon.svg" type="image/svg+xml"/>
        <link rel="stylesheet" href="/static/css/fonts.css"/>
        <link rel="stylesheet" href="/static/css/tokens.css"/>
        <link rel="stylesheet" href="/static/css/app.css"/>
      </head>
      <body>
        <main id="main">
          <section class="wrap prose pad-top">
            <p class="eyebrow">Atom feed</p>
            <h1><xsl:value-of select="atom:feed/atom:title"/></h1>
            <p class="lede"><xsl:value-of select="atom:feed/atom:subtitle"/></p>

            <p>
              This is a feed, not a page. Copy the address out of the address bar
              into a reader and it will tell you when something here changes.
              <a href="/">The site itself is this way.</a>
            </p>

            <section class="section">
              <h2>In the feed</h2>
              <div class="stack-lg" style="margin-top: var(--s-5);">
                <xsl:for-each select="atom:feed/atom:entry">
                  <article style="border-bottom: 1px solid var(--hairline); padding-bottom: var(--s-4);">
                    <p class="eyebrow">
                      <xsl:value-of select="substring(atom:updated, 1, 10)"/>
                    </p>
                    <h3 style="font-size: 1.2rem;">
                      <a href="{atom:link/@href}"><xsl:value-of select="atom:title"/></a>
                    </h3>
                  </article>
                </xsl:for-each>
              </div>
            </section>
          </section>
        </main>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
