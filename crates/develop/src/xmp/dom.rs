//! A tiny namespace-resolved element tree over `quick-xml`, enough to read XMP packets and to re-write a
//! sidecar with some properties replaced. Comments, processing instructions and the DOCTYPE are dropped;
//! attribute order, raw qualified names and `xmlns` declarations are kept so the output keeps the
//! original prefixes.

use quick_xml::events::{BytesStart, Event};
use quick_xml::name::ResolveResult;
use quick_xml::{NsReader, XmlVersion};

use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Attr {
    /// As written, e.g. `crs:Exposure2012` or `xmlns:crs`.
    pub qname: String,
    /// Resolved namespace URI (`None` for unprefixed attributes and `xmlns` declarations).
    pub ns: Option<String>,
    pub local: String,
    /// Unescaped value.
    pub value: String,
}

impl Attr {
    pub fn is_xmlns(&self) -> bool {
        self.qname == "xmlns" || self.qname.starts_with("xmlns:")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Element {
    pub qname: String,
    pub ns: Option<String>,
    pub local: String,
    pub attrs: Vec<Attr>,
    pub children: Vec<Node>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Node {
    Element(Element),
    Text(String),
}

impl Element {
    pub fn is(&self, ns: &str, local: &str) -> bool {
        self.ns.as_deref() == Some(ns) && self.local == local
    }

    pub fn elements(&self) -> impl Iterator<Item = &Element> {
        self.children.iter().filter_map(|n| match n {
            Node::Element(e) => Some(e),
            Node::Text(_) => None,
        })
    }

    /// Concatenated text of the direct text children.
    pub fn text(&self) -> String {
        self.children
            .iter()
            .filter_map(|n| match n {
                Node::Text(t) => Some(t.as_str()),
                Node::Element(_) => None,
            })
            .collect()
    }

    pub fn attr(&self, ns: &str, local: &str) -> Option<&str> {
        self.attrs.iter().find(|a| a.ns.as_deref() == Some(ns) && a.local == local).map(|a| a.value.as_str())
    }

    /// Depth-first search for the first element named `(ns, local)`, `self` included.
    pub fn find(&self, ns: &str, local: &str) -> Option<&Element> {
        if self.is(ns, local) {
            return Some(self);
        }
        self.elements().find_map(|e| e.find(ns, local))
    }

    pub fn find_mut(&mut self, ns: &str, local: &str) -> Option<&mut Element> {
        if self.is(ns, local) {
            return Some(self);
        }
        self.children.iter_mut().find_map(|n| match n {
            Node::Element(e) => e.find_mut(ns, local),
            Node::Text(_) => None,
        })
    }
}

fn xml_err(e: impl std::fmt::Display) -> Error {
    Error::Invalid(format!("XMP: {e}"))
}

fn resolved(r: ResolveResult<'_>) -> Option<String> {
    match r {
        ResolveResult::Bound(ns) => Some(ns.0.to_string()),
        _ => None,
    }
}

fn make_element(reader: &NsReader<&[u8]>, e: &BytesStart<'_>) -> Result<Element> {
    let (ns, local) = reader.resolver().resolve_element(e.name());
    let mut attrs = Vec::new();
    for a in e.attributes() {
        let a = a.map_err(xml_err)?;
        let qname = a.key.0.to_string();
        let value = a.normalized_value(XmlVersion::Implicit1_0).map_err(xml_err)?.into_owned();
        let is_xmlns = qname == "xmlns" || qname.starts_with("xmlns:");
        let (ans, alocal) = if is_xmlns {
            (None, qname.clone())
        } else {
            let (r, l) = reader.resolver().resolve_attribute(a.key);
            (resolved(r), l.as_ref().to_string())
        };
        attrs.push(Attr { qname, ns: ans, local: alocal, value });
    }
    Ok(Element { qname: e.name().0.to_string(), ns: resolved(ns), local: local.as_ref().to_string(), attrs, children: Vec::new() })
}

fn push_text(stack: &mut [Element], text: &str) {
    if let Some(top) = stack.last_mut() {
        if let Some(Node::Text(t)) = top.children.last_mut() {
            t.push_str(text);
        } else {
            top.children.push(Node::Text(text.to_string()));
        }
    }
}

/// Parse `xml` and return its root element.
pub(crate) fn parse(xml: &str) -> Result<Element> {
    let xml = xml.trim_start_matches('\u{feff}');
    let mut reader = NsReader::from_str(xml);
    let mut stack: Vec<Element> = Vec::new();
    let mut root: Option<Element> = None;
    let attach = |stack: &mut Vec<Element>, root: &mut Option<Element>, el: Element| match stack.last_mut() {
        Some(parent) => parent.children.push(Node::Element(el)),
        None => {
            if root.is_none() {
                *root = Some(el);
            }
        }
    };
    loop {
        match reader.read_event().map_err(xml_err)? {
            Event::Start(e) => {
                let el = make_element(&reader, &e)?;
                stack.push(el);
            }
            Event::Empty(e) => {
                let el = make_element(&reader, &e)?;
                attach(&mut stack, &mut root, el);
            }
            Event::End(_) => {
                let el = stack.pop().ok_or_else(|| xml_err("unbalanced end tag"))?;
                attach(&mut stack, &mut root, el);
            }
            Event::Text(t) => push_text(&mut stack, &t.xml10_content()),
            Event::CData(c) => push_text(&mut stack, &c.into_inner()),
            Event::GeneralRef(r) => {
                let ch = if r.is_char_ref() {
                    r.resolve_char_ref().map_err(xml_err)?
                } else {
                    match &*r {
                        "amp" => Some('&'),
                        "lt" => Some('<'),
                        "gt" => Some('>'),
                        "quot" => Some('"'),
                        "apos" => Some('\''),
                        _ => None,
                    }
                };
                if let Some(ch) = ch {
                    push_text(&mut stack, ch.encode_utf8(&mut [0; 4]));
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err(xml_err("unexpected end of document"));
    }
    root.ok_or_else(|| xml_err("no root element"))
}

pub(crate) fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

pub(crate) fn escape_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\n' => out.push_str("&#xA;"),
            '\r' => out.push_str("&#xD;"),
            '\t' => out.push_str("&#x9;"),
            _ => out.push(c),
        }
    }
    out
}

/// Serialise `el` with one-space indentation per level. Whitespace-only text is re-indented; other text
/// is written as it is.
pub(crate) fn write(out: &mut String, el: &Element, depth: usize) {
    let pad = " ".repeat(depth);
    out.push_str(&pad);
    out.push('<');
    out.push_str(&el.qname);
    if el.attrs.len() <= 1 {
        for a in &el.attrs {
            out.push_str(&format!(" {}=\"{}\"", a.qname, escape_attr(&a.value)));
        }
    } else {
        for a in &el.attrs {
            out.push_str(&format!("\n{pad}   {}=\"{}\"", a.qname, escape_attr(&a.value)));
        }
    }
    let has_content = el.children.iter().any(|n| match n {
        Node::Element(_) => true,
        Node::Text(t) => !t.trim().is_empty(),
    });
    if !has_content {
        out.push_str("/>\n");
        return;
    }
    let only_text = el.children.iter().all(|n| matches!(n, Node::Text(_)));
    if only_text {
        out.push('>');
        out.push_str(&escape_text(&el.text()));
    } else {
        out.push_str(">\n");
        for n in &el.children {
            match n {
                Node::Element(e) => write(out, e, depth + 1),
                Node::Text(t) if t.trim().is_empty() => {}
                Node::Text(t) => {
                    out.push_str(&escape_text(t));
                    out.push('\n');
                }
            }
        }
        out.push_str(&pad);
    }
    out.push_str("</");
    out.push_str(&el.qname);
    out.push_str(">\n");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_namespaces_entities_and_round_trips() {
        let xml = r#"<?xml version="1.0"?><a:root xmlns:a="urn:a" xmlns:b="urn:b" b:x="1 &amp; 2"><b:child>x &lt; y&#33;</b:child><b:e/></a:root>"#;
        let root = parse(xml).unwrap();
        assert!(root.is("urn:a", "root"));
        assert_eq!(root.attr("urn:b", "x"), Some("1 & 2"));
        let child = root.find("urn:b", "child").unwrap();
        assert_eq!(child.text(), "x < y!");
        let mut out = String::new();
        write(&mut out, &root, 0);
        fn strip(e: &mut Element) {
            e.children.retain(|n| !matches!(n, Node::Text(t) if t.trim().is_empty()));
            for n in &mut e.children {
                if let Node::Element(c) = n {
                    strip(c);
                }
            }
        }
        let mut back = parse(&out).unwrap();
        strip(&mut back);
        assert_eq!(back, root);
    }

    #[test]
    fn rejects_broken_xml() {
        assert!(parse("<a><b></a>").is_err());
        assert!(parse("").is_err());
    }
}
