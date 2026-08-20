import Foundation
import FoundationModels

/// Errors produced while mapping a JSON Schema document onto the
/// Foundation Models `DynamicGenerationSchema` representation.
enum SchemaConversionError: Error, CustomStringConvertible {
    case unsupportedType(String)
    case invalidSchema(String)

    var description: String {
        switch self {
        case .unsupportedType(let t): return "unsupported JSON Schema type: \(t)"
        case .invalidSchema(let m): return "invalid JSON Schema: \(m)"
        }
    }
}

/// Convert a JSON-Schema-shaped dictionary into a Foundation Models
/// `DynamicGenerationSchema`.
///
/// Supported subset (covers sqz-schema.json and the SQZ AST shape):
///   - object + properties + required
///   - string / integer / number / boolean
///   - array + items
///   - enum (string choices) and const
///   - anyOf / oneOf of schemas
/// Unsupported constructs degrade to a plain string schema rather than
/// failing the whole request — the model prompt still carries the original
/// schema text, so output validation happens on the TS side regardless.
func convertSchema(_ schema: [String: Any], name: String? = nil) throws -> DynamicGenerationSchema {
    let fallbackName = name ?? "Root"

    if let anyOf = schema["anyOf"] as? [[String: Any]], !anyOf.isEmpty {
        let choices = try anyOf.map { try convertSchema($0) }
        return DynamicGenerationSchema(name: fallbackName, anyOf: choices)
    }
    if let oneOf = schema["oneOf"] as? [[String: Any]], !oneOf.isEmpty {
        let choices = try oneOf.map { try convertSchema($0) }
        return DynamicGenerationSchema(name: fallbackName, anyOf: choices)
    }
    if let ref = schema["$ref"] as? String {
        return DynamicGenerationSchema(referenceTo: ref)
    }

    switch schema["type"] as? String {
    case "object", nil:
        let props = schema["properties"] as? [String: Any] ?? [:]
        let required = schema["required"] as? [String] ?? []
        var properties: [DynamicGenerationSchema.Property] = []
        for (key, value) in props {
            guard let prop = value as? [String: Any] else { continue }
            let child = try convertSchema(prop)
            properties.append(
                DynamicGenerationSchema.Property(
                    name: key,
                    description: prop["description"] as? String,
                    schema: child,
                    isOptional: !required.contains(key)
                )
            )
        }
        return DynamicGenerationSchema(name: fallbackName, properties: properties)

    case "string":
        if let enumVals = schema["enum"] as? [String], !enumVals.isEmpty {
            return DynamicGenerationSchema(name: fallbackName, anyOf: enumVals)
        }
        if let const = schema["const"] as? String {
            return DynamicGenerationSchema(name: fallbackName, anyOf: [const])
        }
        return DynamicGenerationSchema(type: String.self)

    case "integer":
        return DynamicGenerationSchema(type: Int.self)

    case "number":
        return DynamicGenerationSchema(type: Double.self)

    case "boolean":
        return DynamicGenerationSchema(type: Bool.self)

    case "array":
        if let items = schema["items"] as? [String: Any] {
            return DynamicGenerationSchema(arrayOf: try convertSchema(items))
        }
        return DynamicGenerationSchema(arrayOf: DynamicGenerationSchema(type: String.self))

    default:
        if let const = schema["const"] {
            if let s = const as? String {
                return DynamicGenerationSchema(name: fallbackName, anyOf: [s])
            }
            // Non-string const: fall back to the inferred scalar type.
            switch const {
            case is Bool: return DynamicGenerationSchema(type: Bool.self)
            case is Int: return DynamicGenerationSchema(type: Int.self)
            case is Double: return DynamicGenerationSchema(type: Double.self)
            default: return DynamicGenerationSchema(type: String.self)
            }
        }
        throw SchemaConversionError.unsupportedType(schema["type"] as? String ?? "unknown")
    }
}